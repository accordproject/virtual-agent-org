// Owner controls: approve, reject, pause, resume, stop, revoke.

import { messageAgent, refreshDecisionCard, type ReplyTo } from "./agents";
import { cap, type Ctx } from "./context";
import { executeDecision } from "./executors";

function deploymentsFor(ctx: Ctx, agent: string): string[] {
  return Object.values(ctx.deployed.deployments)
    .filter((d) => d.agent === agent)
    .map((d) => d.id);
}

export async function approve(ctx: Ctx, id: string): Promise<string> {
  if (!(await ctx.db.decide(id, "approved"))) return `${id} is not open.`;
  const d = (await ctx.db.getDecision(id))!;
  await ctx.db.audit({ agent: d.agent, session_id: d.session_id ?? undefined, event_type: "owner.approved", detail: { id } });
  try {
    const r = await executeDecision(ctx, d);
    if (!r.manual) await ctx.db.markExecuted(id, r.ok, r.result);
    else await ctx.db.setNote(id, r.result);
    await refreshDecisionCard(ctx, id);
    return `${id}: ${r.result}`;
  } catch (err) {
    await ctx.db.markExecuted(id, false, String(err));
    await refreshDecisionCard(ctx, id);
    return `${id} failed: ${String(err)}`;
  }
}

export async function reject(ctx: Ctx, id: string, note?: string): Promise<string> {
  if (!(await ctx.db.decide(id, "rejected", note))) {
    // Allow a note to be added after the reject tap.
    const d = await ctx.db.getDecision(id);
    if (d?.status === "rejected" && note) {
      await ctx.db.setNote(id, note);
      await refreshDecisionCard(ctx, id);
      return `Note added to ${id}.`;
    }
    return `${id} is not open.`;
  }
  const d = (await ctx.db.getDecision(id))!;
  await ctx.db.audit({ agent: d.agent, session_id: d.session_id ?? undefined, event_type: "owner.rejected", detail: { id, note } });
  if (d.kind === "tool.confirm" && d.session_id && d.tool_use_id) {
    await ctx.managed.sendToolConfirmation(
      d.session_id,
      d.tool_use_id,
      false,
      note ?? "Rejected by the owner. Do not retry; check get_decisions for a note.",
    );
  }
  await refreshDecisionCard(ctx, id);
  return `${id} rejected.`;
}

export async function markDone(ctx: Ctx, id: string): Promise<string> {
  const d = await ctx.db.getDecision(id);
  if (d?.status !== "approved") return `${id} is not waiting on you.`;
  await ctx.db.markExecuted(id, true, "Done by owner");
  await refreshDecisionCard(ctx, id);
  return `${id} marked done.`;
}

export async function askAda(ctx: Ctx, id: string, to: ReplyTo): Promise<string> {
  const d = await ctx.db.getDecision(id);
  if (!d) return `${id} not found.`;
  await messageAgent(
    ctx,
    "ada",
    to,
    `Matt asks about ${id} (${d.agent}, ${d.kind}): "${d.summary}". Explain what it does, the evidence, the risks and your recommendation in a few lines.`,
  );
  return `Asked Ada about ${id}.`;
}

export async function pause(ctx: Ctx, agent: string): Promise<string> {
  await ctx.db.setAgentStatus(agent, "paused");
  const errors: string[] = [];
  for (const id of deploymentsFor(ctx, agent)) {
    await ctx.managed.pauseDeployment(id).catch((e) => errors.push(String(e)));
  }
  await ctx.db.audit({ agent, event_type: "owner.paused" });
  return `${cap(agent)} paused: no new tasks or scheduled runs. Running sessions finish.` + (errors.length ? `\nErrors: ${errors.join("; ")}` : "");
}

export async function resume(ctx: Ctx, agent: string): Promise<string> {
  const status = await ctx.db.agentStatus(agent);
  if (status === "revoked") return `${cap(agent)} is revoked. Redeploy it before resuming.`;
  await ctx.db.setAgentStatus(agent, "active");
  for (const id of deploymentsFor(ctx, agent)) await ctx.managed.unpauseDeployment(id).catch(() => undefined);
  await ctx.db.audit({ agent, event_type: "owner.resumed" });
  return `${cap(agent)} resumed.`;
}

export async function stop(ctx: Ctx, agent: string): Promise<string> {
  await ctx.db.setAgentStatus(agent, "stopped");
  for (const id of deploymentsFor(ctx, agent)) await ctx.managed.pauseDeployment(id).catch(() => undefined);
  let interrupted = 0;
  for (const s of await ctx.db.activeSessions(agent)) {
    await ctx.managed.interrupt(s.id).then(() => interrupted++).catch(() => undefined);
  }
  let rejected = 0;
  for (const d of await ctx.db.listDecisions({ status: "open", agent })) {
    await reject(ctx, d.id, "Agent stopped by owner.");
    rejected++;
  }
  await ctx.db.audit({ agent, event_type: "owner.stopped", detail: { interrupted, rejected } });
  return `${cap(agent)} stopped: ${interrupted} session(s) interrupted, ${rejected} open decision(s) rejected. /resume ${agent} to restart.`;
}

export async function revoke(ctx: Ctx, agent: string): Promise<string> {
  const stopped = await stop(ctx, agent);
  await ctx.db.setAgentStatus(agent, "revoked");
  const dep = ctx.deployed.agents[agent];
  const archived: string[] = [];
  for (const v of dep?.vault_ids ?? []) {
    await ctx.managed.archiveVault(v).then(() => archived.push(v)).catch(() => undefined);
  }
  await ctx.db.audit({ agent, event_type: "owner.revoked", detail: { archived } });
  return [
    stopped,
    `${cap(agent)} revoked. ${archived.length} vault(s) archived (credentials purged).`,
    "Finish by hand:",
    `1. GitHub: uninstall the ${agent} GitHub App from the organisation.`,
    "2. Console: archive the agent if you are retiring it for good.",
  ].join("\n");
}
