import { cap, type Ctx } from "./context";
import type { Decision, SessionRow } from "./db";
import { decisionButtons, decisionCard } from "./format";

export class AgentUnavailable extends Error {}

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
  opts: { chatId?: number; taskId?: string } = {},
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
  await ctx.db.upsertSession({ id: session.id, agent, origin, chat_id: opts.chatId, task_id: opts.taskId });
  await ctx.db.audit({ agent, session_id: session.id, event_type: "gateway.session_started", detail: { origin, task: opts.taskId } });
  return session.id;
}

/** Sends a message to an agent, continuing a recent Telegram conversation if there is one. */
export async function messageAgent(ctx: Ctx, agent: string, chatId: number, text: string): Promise<string> {
  await assertAvailable(ctx, agent);
  const recent = await ctx.db.recentChatSession(agent, chatId);
  if (recent) {
    await ctx.managed.sendMessage(recent.id, text);
    await ctx.db.updateSession(recent.id, "running", recent.cost_cents);
    return recent.id;
  }
  return startSession(ctx, agent, text, "telegram", { chatId });
}

export async function postDecision(ctx: Ctx, d: Decision) {
  const id = await ctx.tg.send(ctx.ownerChatId, decisionCard(d), { buttons: decisionButtons(d) });
  await ctx.db.setDecisionMessage(d.id, id);
}

export async function refreshDecisionCard(ctx: Ctx, id: string) {
  const d = await ctx.db.getDecision(id);
  if (!d?.tg_message_id) return;
  try {
    await ctx.tg.edit(ctx.ownerChatId, d.tg_message_id, decisionCard(d), decisionButtons(d));
  } catch {
    // Message too old to edit or unchanged; the queue state is still correct.
  }
}
