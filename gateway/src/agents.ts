import { cap, type Ctx } from "./context";
import type { Decision, SessionRow, StartedBy } from "./db";
import { decisionButtons, decisionCard, discordCard } from "./format";
import { ManagedAgentsError } from "./managed";
import { riskAtMost } from "./risk";

export class AgentUnavailable extends Error {}

/**
 * What to tell someone whose request failed. The owner gets the error; anyone else a
 * plain line, since errors can carry API responses. The full error always goes to the
 * audit log. An unavailable agent is said plainly to everyone, as /status shows it anyway.
 */
export async function failureText(ctx: Ctx, owner: boolean, e: unknown, event: string, detail: Record<string, unknown> = {}): Promise<string> {
  if (e instanceof AgentUnavailable) return e.message;
  const error = e instanceof Error ? e.message : String(e);
  await ctx.db.audit({ event_type: event, detail: { ...detail, error } });
  return owner ? `That didn't work: ${error}` : "That didn't work; it's logged for Matt.";
}

/** Where an agent's replies go for a conversation someone started. */
export type ReplyTo = { telegram: number } | { discord: string };

/** Checks phase, deployment and owner controls before any new work starts. */
export async function assertAvailable(ctx: Ctx, agent: string) {
  const cfg = ctx.network.agents[agent];
  if (!cfg) throw new AgentUnavailable(`No agent called ${agent}`);
  if (cfg.phase > ctx.network.current_phase) {
    throw new AgentUnavailable(`${cap(agent)} starts in phase ${cfg.phase}; the network is in phase ${ctx.network.current_phase}`);
  }
  if (!ctx.deployed.agents[agent]) throw new AgentUnavailable(`${cap(agent)} is not deployed yet`);
  const status = await ctx.db.agentStatus(agent);
  if (status !== "active") throw new AgentUnavailable(`${cap(agent)} is ${status}`);
}

export async function startSession(
  ctx: Ctx,
  agent: string,
  text: string,
  origin: SessionRow["origin"],
  startedBy: StartedBy,
  opts: { chatId?: number; discordUser?: string; taskId?: string; budgetCents?: number; model?: string } = {},
): Promise<string> {
  await assertAvailable(ctx, agent);
  const dep = ctx.deployed.agents[agent];
  const session = await ctx.managed.createSession({
    agentId: dep.agent_id,
    environmentId: dep.environment_id,
    vaultIds: dep.vault_ids,
    memoryStoreIds: dep.memory_store_ids.map((id, i) => ({
      id,
      // The first store is the agent's own; the rest (shared context) are read-only.
      access: i === 0 ? "read_write" : "read_only",
    })),
    text,
    budgetCents: opts.budgetCents ?? dep.session_budget_cents,
    ...(opts.model ? { model: opts.model } : {}),
  });
  await ctx.db.upsertSession({
    id: session.id,
    agent,
    origin,
    chat_id: opts.chatId,
    discord_user: opts.discordUser,
    task_id: opts.taskId,
    started_by: startedBy,
  });
  await ctx.db.audit({ agent, session_id: session.id, event_type: "gateway.session_started", detail: { origin, task: opts.taskId, started_by: startedBy } });
  return session.id;
}

/**
 * Sends a message to an agent, continuing a recent conversation in the same app if there is one.
 * `startedBy` is who is speaking; a conversation a member has spoken in stays marked as theirs.
 */
export async function messageAgent(ctx: Ctx, agent: string, to: ReplyTo, text: string, startedBy: StartedBy): Promise<string> {
  await assertAvailable(ctx, agent);
  const found =
    "telegram" in to ? await ctx.db.recentChatSession(agent, to.telegram) : await ctx.db.recentDiscordSession(agent, to.discord);
  // Don't continue a conversation that has used most of its budget: start fresh instead.
  const budget = ctx.deployed.agents[agent]?.session_budget_cents ?? 0;
  const recent = found && !(budget && found.cost_cents >= budget * 0.8) ? found : null;
  if (recent) {
    try {
      await ctx.managed.sendMessage(recent.id, text);
      await ctx.db.updateSession(recent.id, "running", recent.cost_cents);
      await ctx.db.markMemberSession(recent.id, startedBy);
      return recent.id;
    } catch (e) {
      // The last conversation is paused or out of budget: start a fresh one.
      if (!isWaitingSession(e)) throw e;
      await ctx.db.audit({ agent, session_id: recent.id, event_type: "gateway.session_waiting", detail: `started a new session instead: ${(e as ManagedAgentsError).body.slice(0, 120)}` });
    }
  }
  return "telegram" in to
    ? startSession(ctx, agent, text, "telegram", startedBy, { chatId: to.telegram })
    : startSession(ctx, agent, text, "discord", startedBy, { discordUser: to.discord });
}

/**
 * Managed Agents refuses new messages while a session waits on tool results or
 * confirmations, or once it has spent its budget.
 */
export function isWaitingSession(e: unknown): boolean {
  return e instanceof ManagedAgentsError && e.status === 400 && /waiting on responses|session budget reached/i.test(e.body);
}

/** Whether the owner may approve this decision from Discord (decision 15B). */
export function discordApprovable(ctx: Ctx, d: Pick<Decision, "kind" | "risk">): boolean {
  if (d.kind === "tool.confirm") return false;
  return riskAtMost(d.risk, ctx.network.discord_approval_max_risk ?? "none");
}

/**
 * Sends the owner the approval card. With approvals_app "discord", a card that can
 * be approved in Discord goes only there; everything else, and any card Discord
 * fails to deliver, goes to Telegram, so no decision is ever lost.
 */
export async function postDecision(ctx: Ctx, d: Decision) {
  const app = ctx.network.approvals_app ?? "both";
  const onDiscord = app !== "telegram" && (await postDiscordCard(ctx, d));
  if (onDiscord && app === "discord") return;
  const id = await ctx.tg.send(ctx.ownerChatId, decisionCard(d), { buttons: decisionButtons(d) });
  await ctx.db.setDecisionMessage(d.id, id);
}

/** DMs the owner the card in Discord, for decisions they may approve there. True if it was delivered. */
export async function postDiscordCard(ctx: Ctx, d: Decision): Promise<boolean> {
  if (!ctx.dc || !ctx.ownerDiscordId || !discordApprovable(ctx, d)) return false;
  try {
    const m = await ctx.dc.dm(ctx.ownerDiscordId, discordCard(d));
    await ctx.db.setDiscordMessage(d.id, m.channelId, m.messageId);
    return true;
  } catch (e) {
    await ctx.db.audit({ agent: d.agent, event_type: "gateway.discord_error", detail: { id: d.id, error: String(e) } });
    return false;
  }
}

export async function refreshDecisionCard(ctx: Ctx, id: string) {
  const d = await ctx.db.getDecision(id);
  if (!d) return;
  if (d.tg_message_id) {
    try {
      await ctx.tg.edit(ctx.ownerChatId, d.tg_message_id, decisionCard(d), decisionButtons(d));
    } catch {
      // Message too old to edit or unchanged; the queue state is still correct.
    }
  }
  if (d.discord_channel_id && d.discord_message_id && ctx.dc) {
    try {
      await ctx.dc.edit(d.discord_channel_id, d.discord_message_id, discordCard(d));
    } catch {
      // Same: the decision record is authoritative.
    }
  }
}

/** Sends an agent's reply to wherever the conversation started. */
export async function replyToOrigin(ctx: Ctx, row: Pick<SessionRow, "chat_id" | "discord_user">, text: string) {
  if (row.chat_id) await ctx.tg.send(row.chat_id, text);
  if (row.discord_user && ctx.dc) await ctx.dc.dm(row.discord_user, { content: text });
}
