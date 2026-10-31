import { cap, type Ctx } from "./context";
import type { Decision, SessionRow } from "./db";
import { decisionButtons, decisionCard, discordButtons } from "./format";
import { ManagedAgentsError } from "./managed";

export class AgentUnavailable extends Error {}

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
  opts: { chatId?: number; discordUser?: string; taskId?: string } = {},
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
    budgetCents: dep.session_budget_cents,
  });
  await ctx.db.upsertSession({
    id: session.id,
    agent,
    origin,
    chat_id: opts.chatId,
    discord_user: opts.discordUser,
    task_id: opts.taskId,
  });
  await ctx.db.audit({ agent, session_id: session.id, event_type: "gateway.session_started", detail: { origin, task: opts.taskId } });
  return session.id;
}

/** Sends a message to an agent, continuing a recent conversation in the same app if there is one. */
export async function messageAgent(ctx: Ctx, agent: string, to: ReplyTo, text: string): Promise<string> {
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
      return recent.id;
    } catch (e) {
      // The last conversation is paused or out of budget: start a fresh one.
      if (!isWaitingSession(e)) throw e;
      await ctx.db.audit({ agent, session_id: recent.id, event_type: "gateway.session_waiting", detail: `started a new session instead: ${(e as ManagedAgentsError).body.slice(0, 120)}` });
    }
  }
  return "telegram" in to
    ? startSession(ctx, agent, text, "telegram", { chatId: to.telegram })
    : startSession(ctx, agent, text, "discord", { discordUser: to.discord });
}

/**
 * Managed Agents refuses new messages while a session waits on tool results or
 * confirmations, or once it has spent its budget.
 */
export function isWaitingSession(e: unknown): boolean {
  return e instanceof ManagedAgentsError && e.status === 400 && /waiting on responses|session budget reached/i.test(e.body);
}

const RISK_ORDER = ["none", "low", "medium", "high"];

/** Whether the owner may approve this decision from Discord (decision 15B). */
export function discordApprovable(ctx: Ctx, d: Pick<Decision, "kind" | "risk">): boolean {
  if (d.kind === "tool.confirm") return false;
  const max = ctx.network.discord_approval_max_risk ?? "none";
  const risk = RISK_ORDER.indexOf(d.risk);
  return risk > 0 && risk <= RISK_ORDER.indexOf(max);
}

export async function postDecision(ctx: Ctx, d: Decision) {
  const id = await ctx.tg.send(ctx.ownerChatId, decisionCard(d), { buttons: decisionButtons(d) });
  await ctx.db.setDecisionMessage(d.id, id);
  await postDiscordCard(ctx, d);
}

/** DMs the owner a Discord copy of the card, for decisions they may approve there. */
export async function postDiscordCard(ctx: Ctx, d: Decision) {
  if (!ctx.dc || !ctx.ownerDiscordId || !discordApprovable(ctx, d)) return;
  try {
    const m = await ctx.dc.dm(ctx.ownerDiscordId, { content: decisionCard(d), buttons: discordButtons(d) });
    await ctx.db.setDiscordMessage(d.id, m.channelId, m.messageId);
  } catch (e) {
    // Telegram has the card; a Discord failure must not lose the decision.
    await ctx.db.audit({ agent: d.agent, event_type: "gateway.discord_error", detail: { id: d.id, error: String(e) } });
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
      await ctx.dc.edit(d.discord_channel_id, d.discord_message_id, { content: decisionCard(d), buttons: discordButtons(d) });
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
