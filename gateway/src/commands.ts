// Telegram update handling: who is speaking, what they may do, and routing.

import { AgentUnavailable, messageAgent, postDecision } from "./agents";
import { cap, type Ctx } from "./context";
import { approve, askAda, markDone, pause, reject, resume, revoke, stop } from "./controls";
import type { Role } from "./env";
import type { TgMessage, TgUpdate } from "./telegram";

const PERMS: Record<Role, Set<string>> = {
  owner: new Set(["instruct", "approve", "control", "ask", "status", "queue"]),
  tsc_member: new Set(["ask", "status", "queue"]),
};

export function roleOf(ctx: Ctx, userId: number | undefined): Role | null {
  if (!userId) return null;
  if (String(userId) === ctx.env.OWNER_TELEGRAM_ID) return "owner";
  const tsc = (ctx.env.TSC_TELEGRAM_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return tsc.includes(String(userId)) ? "tsc_member" : null;
}

const HELP = `Commands
(plain text) — message Ada
/status — each agent: state, last report, open work, spend
/queue — open decisions with buttons
/approve D-41 · /reject D-41 <note>
/ask <agent> <text> — talk to one agent directly
/pause <agent> · /resume <agent>
/stop <agent|all> — interrupt sessions, reject its open decisions
/revoke <agent> confirm — stop and purge its credentials
/whoami`;

export async function handleUpdate(ctx: Ctx, u: TgUpdate): Promise<void> {
  if (u.callback_query) return handleCallback(ctx, u.callback_query);
  if (u.message?.text) return handleMessage(ctx, u.message);
}

async function handleCallback(ctx: Ctx, q: NonNullable<TgUpdate["callback_query"]>) {
  const role = roleOf(ctx, q.from.id);
  if (role !== "owner") {
    await ctx.tg.answerCallback(q.id, "Only the owner can decide.");
    return;
  }
  const [action, id] = (q.data ?? "").split(":");
  const chatId = q.message?.chat.id ?? ctx.ownerChatId;
  let reply = "";
  switch (action) {
    case "a":
      reply = await approve(ctx, id);
      break;
    case "r": {
      reply = await reject(ctx, id);
      const msgId = await ctx.tg.send(chatId, `Note for ${id}? Reply to this message, or ignore it.`, { forceReply: true });
      await ctx.db.addPendingReply(msgId, chatId, "reject_note", id);
      break;
    }
    case "k":
      reply = await askAda(ctx, id, chatId);
      break;
    case "x":
      reply = await markDone(ctx, id);
      break;
  }
  await ctx.tg.answerCallback(q.id, reply.slice(0, 190));
}

async function handleMessage(ctx: Ctx, m: TgMessage) {
  const role = roleOf(ctx, m.from?.id);
  if (!role) {
    await ctx.db.audit({ event_type: "telegram.unauthorised", detail: { from: m.from?.id, username: m.from?.username } });
    return; // silent: don't confirm the bot exists to strangers
  }
  if (m.chat.type !== "private" && role === "owner" && !m.text?.startsWith("/")) {
    // In groups, only commands are handled, so chatter doesn't reach Ada.
    return;
  }
  const can = (p: string) => PERMS[role].has(p);
  const reply = (text: string) => ctx.tg.send(m.chat.id, text, { replyTo: m.message_id });
  const text = m.text!.trim();

  // Replies to a force-reply prompt (e.g. a rejection note).
  if (m.reply_to_message && role === "owner") {
    const pending = await ctx.db.takePendingReply(m.reply_to_message.message_id);
    if (pending?.kind === "reject_note") {
      await reply(await reject(ctx, pending.ref, text));
      return;
    }
  }

  if (!text.startsWith("/")) {
    if (!can("instruct") && !can("ask")) return;
    const prefix = role === "owner" ? "" : `A TSC member (Telegram ${m.from?.id}) asks. They cannot instruct or approve; answer only.\n\n`;
    try {
      await messageAgent(ctx, "ada", m.chat.id, prefix + text);
    } catch (e) {
      await reply(e instanceof AgentUnavailable ? e.message : `Could not reach Ada: ${String(e)}`);
    }
    return;
  }

  const [rawCmd, ...args] = text.split(/\s+/);
  const cmd = rawCmd.split("@")[0].toLowerCase();
  const agentArg = (args[0] ?? "").toLowerCase();
  const knownAgent = (a: string) => !!ctx.network.agents[a];
  const allAgents = Object.keys(ctx.network.agents);

  try {
    switch (cmd) {
      case "/start":
      case "/help":
        await reply(HELP);
        return;
      case "/whoami":
        await reply(`Telegram id ${m.from?.id} · role ${role}`);
        return;
      case "/status":
        if (!can("status")) return;
        await reply(await statusText(ctx));
        return;
      case "/queue": {
        if (!can("queue")) return;
        const open = await ctx.db.listDecisions({ status: "open" });
        if (!open.length) {
          await reply("Queue is empty.");
          return;
        }
        if (role === "owner") for (const d of open.slice(0, 10)) await postDecision(ctx, d);
        else await reply(open.map((d) => `${d.id} · ${cap(d.agent)} · ${d.summary}`).join("\n"));
        if (open.length > 10) await reply(`${open.length - 10} more. Clear these first.`);
        return;
      }
      case "/approve":
        if (!can("approve")) return;
        await reply(await approve(ctx, args[0] ?? ""));
        return;
      case "/reject":
        if (!can("approve")) return;
        await reply(await reject(ctx, args[0] ?? "", args.slice(1).join(" ") || undefined));
        return;
      case "/ask": {
        if (!can("ask")) return;
        if (!knownAgent(agentArg) || args.length < 2) {
          await reply("Usage: /ask <agent> <text>");
          return;
        }
        await messageAgent(ctx, agentArg, m.chat.id, args.slice(1).join(" "));
        await ctx.db.audit({ agent: agentArg, event_type: "owner.direct_ask", detail: { by: role } });
        return;
      }
      case "/pause":
      case "/resume":
      case "/stop":
      case "/revoke": {
        if (!can("control")) return;
        const targets = agentArg === "all" && cmd === "/stop" ? allAgents : knownAgent(agentArg) ? [agentArg] : [];
        if (!targets.length) {
          await reply(`Usage: ${cmd} <agent>${cmd === "/stop" ? "|all" : ""}`);
          return;
        }
        if (cmd === "/revoke" && args[1] !== "confirm") {
          await reply(`Revoking ${agentArg} stops it and purges its credentials. Send: /revoke ${agentArg} confirm`);
          return;
        }
        const fn = { "/pause": pause, "/resume": resume, "/stop": stop, "/revoke": revoke }[cmd]!;
        const out: string[] = [];
        for (const t of targets) out.push(await fn(ctx, t));
        await reply(out.join("\n\n"));
        return;
      }
      default:
        await reply(`Unknown command. ${HELP}`);
    }
  } catch (e) {
    await reply(e instanceof AgentUnavailable ? e.message : `Error: ${String(e)}`);
  }
}

export async function statusText(ctx: Ctx): Promise<string> {
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().replace("T", " ").slice(0, 19);
  const monthStart = new Date().toISOString().slice(0, 8) + "01 00:00:00";
  const [controls, statuses, tasks, open, spendWeek, spendMonth] = await Promise.all([
    ctx.db.allAgentStatuses(),
    ctx.db.latestStatuses(),
    ctx.db.openTasks(),
    ctx.db.listDecisions({ status: "open" }),
    ctx.db.spendByAgent(weekAgo),
    ctx.db.spendByAgent(monthStart),
  ]);
  const usd = (c = 0) => `$${(c / 100).toFixed(2)}`;
  const out = [`Phase ${ctx.network.current_phase}${ctx.dryRun ? " · DRY RUN" : ""}`];
  for (const a of Object.values(ctx.network.agents).sort((x, y) => x.phase - y.phase)) {
    if (a.phase > ctx.network.current_phase) continue;
    const st = statuses.find((s) => s.agent === a.name);
    const deployed = !!ctx.deployed.agents[a.name];
    out.push(
      `${cap(a.name)} (${a.title}) · ${deployed ? controls[a.name] ?? "active" : "not deployed"}` +
        ` · tasks ${tasks.filter((t) => t.agent === a.name).length}` +
        ` · decisions ${open.filter((d) => d.agent === a.name).length}` +
        ` · 7d ${usd(spendWeek[a.name])}` +
        (st ? `\n  last report ${st.at}: ${st.doing[0] ?? st.done[0] ?? "—"}` : ""),
    );
  }
  const month = Object.values(spendMonth).reduce((x, y) => x + y, 0);
  out.push(`Month to date ${usd(month)} of $${ctx.network.monthly_credit_usd} credits`);
  return out.join("\n");
}
