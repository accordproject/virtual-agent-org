import { handleUpdate } from "./commands";
import { verifyDiscord } from "./discordBot";
import { handleInteraction, type Interaction } from "./discordInteractions";
import { makeCtx } from "./context";
import { Db } from "./db";
import { checkEnv, type Env } from "./env";
import { housekeeping, processSession, sweep } from "./sessions";
import type { TgUpdate } from "./telegram";
import { timingSafeEqual, verifyWebhook } from "./webhookVerify";

interface WebhookPayload {
  type: string;
  id: string;
  data?: { type?: string; id?: string };
}

export default {
  async fetch(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // Fail closed while a required secret is missing: no route runs half-configured.
    const problems = checkEnv(env);
    if (req.method === "GET" && url.pathname === "/health") {
      return problems.length ? new Response(`misconfigured:\n${problems.join("\n")}`, { status: 503 }) : new Response("ok");
    }
    if (problems.length) return new Response("gateway misconfigured", { status: 503 });

    if (req.method === "POST" && url.pathname === "/telegram") {
      const token = req.headers.get("x-telegram-bot-api-secret-token");
      if (!token || !timingSafeEqual(token, env.TELEGRAM_WEBHOOK_SECRET)) {
        return new Response("forbidden", { status: 403 });
      }
      const update = (await req.json()) as TgUpdate;
      const ctx = makeCtx(env);
      // Answer Telegram fast; do the work after the response.
      exec.waitUntil(
        handleUpdate(ctx, update).catch((e) => ctx.db.audit({ event_type: "gateway.telegram_error", detail: String(e) })),
      );
      return new Response("ok");
    }

    if (req.method === "POST" && url.pathname === "/discord") {
      if (!env.DISCORD_PUBLIC_KEY) return new Response("not found", { status: 404 });
      const raw = await req.text();
      if (!(await verifyDiscord(env.DISCORD_PUBLIC_KEY, req.headers, raw))) {
        return new Response("bad signature", { status: 401 });
      }
      const ctx = makeCtx(env);
      const body = await handleInteraction(ctx, JSON.parse(raw) as Interaction, (p) => exec.waitUntil(p));
      return Response.json(body);
    }

    if (req.method === "POST" && url.pathname === "/anthropic") {
      const raw = await req.text();
      if (!(await verifyWebhook(env.ANTHROPIC_WEBHOOK_SECRET, req.headers, raw))) {
        return new Response("bad signature", { status: 401 });
      }
      const payload = JSON.parse(raw) as WebhookPayload;
      const ctx = makeCtx(env);
      if (!(await ctx.db.claimEvent(`wh:${payload.id}`))) return new Response("duplicate");

      const type = payload.data?.type ?? "";
      const objectId = payload.data?.id ?? "";
      exec.waitUntil(
        (async () => {
          if (type.startsWith("session.") && objectId) {
            await processSession(ctx, objectId);
          } else if (type === "deployment_run.failed" || type === "deployment.paused") {
            await ctx.tg.send(ctx.ownerChatId, `Scheduled run problem: ${type} (${objectId}). Check the Console.`);
          }
          await ctx.db.audit({ event_type: `webhook.${type}`, detail: { id: objectId } });
        })().catch((e) => ctx.db.audit({ event_type: "gateway.webhook_error", detail: String(e) })),
      );
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(_event: ScheduledController, env: Env, exec: ExecutionContext) {
    const problems = checkEnv(env);
    if (problems.length) {
      exec.waitUntil(new Db(env.DB).audit({ event_type: "gateway.misconfigured", detail: { problems } }));
      return;
    }
    const ctx = makeCtx(env);
    exec.waitUntil(
      (async () => {
        await housekeeping(ctx).catch((e) => ctx.db.audit({ event_type: "gateway.housekeeping_error", detail: String(e) }));
        await sweep(ctx);
      })(),
    );
  },
};
