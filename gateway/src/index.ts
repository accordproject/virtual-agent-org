import { handleUpdate } from "./commands";
import { makeCtx } from "./context";
import type { Env } from "./env";
import { processSession, sweep } from "./sessions";
import type { TgUpdate } from "./telegram";
import { verifyWebhook } from "./webhookVerify";

interface WebhookPayload {
  type: string;
  id: string;
  data?: { type?: string; id?: string };
}

export default {
  async fetch(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") return new Response("ok");

    if (req.method === "POST" && url.pathname === "/telegram") {
      if (req.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) {
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
    const ctx = makeCtx(env);
    exec.waitUntil(sweep(ctx));
  },
};
