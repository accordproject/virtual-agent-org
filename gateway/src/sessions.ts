// Processes a Managed Agents session after a webhook (or the sweeper) says it changed:
// audits every event, answers custom tool calls, turns paused tool calls into
// decisions, and forwards agent replies to Telegram.

import { defaultModel, postDecision, replyToOrigin } from "./agents";
import { agentByManagedId } from "./config";
import { cap, outOfSubrequests, type Ctx } from "./context";
import { wakeAda } from "./followUp";
import { mcpGithubWrite, recordGithubWrite } from "./githubWrites";
import { costCents, messageText, sessionAgentId, sessionModel, sessionTokens, type SessionEvent } from "./managed";
import { ToolDenied, ToolError, handleTool } from "./tools";

/**
 * Why an idle session stopped. The session object carries no stop reason; the latest
 * `session.status_idle` event does. Empty if the events don't include one.
 */
export function stopReason(events: SessionEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "session.status_idle") return events[i].stop_reason?.type ?? "";
  }
  return "";
}

export async function processSession(ctx: Ctx, sessionId: string): Promise<void> {
  const session = await ctx.managed.retrieveSession(sessionId);
  let row = await ctx.db.getSession(sessionId);
  const agent = row?.agent ?? agentByManagedId(sessionAgentId(session) ?? "", ctx.deployed);
  if (!agent) {
    await ctx.db.audit({ session_id: sessionId, event_type: "gateway.unknown_session", detail: { agent: session.agent } });
    return;
  }
  if (!row) {
    // A scheduled run on a task (schedules.yaml) reports its overridden model; record that one.
    await ctx.db.upsertSession({ id: sessionId, agent, origin: "deployment", model: sessionModel(session) ?? defaultModel(ctx, agent) });
    row = await ctx.db.getSession(sessionId);
  }

  const events = await ctx.managed.listEvents(sessionId);
  // Skip what an earlier pass handled in full; event claims cover the rest.
  const doneThrough = await ctx.db.eventsDoneThrough(sessionId);
  const start = doneThrough ? events.findIndex((e) => e.id === doneThrough) + 1 : 0;
  let through = doneThrough;
  let contiguous = true;
  for (const e of events.slice(start)) {
    if (await ctx.db.claimEvent(e.id)) {
      try {
        await handleEvent(ctx, agent, sessionId, { chat_id: row?.chat_id ?? null, discord_user: row?.discord_user ?? null }, e);
        await ctx.db.markEventDone(e.id);
      } catch (err) {
        // Let the sweeper retry this event later.
        contiguous = false;
        await ctx.db.releaseEvent(e.id);
        await ctx.db.audit({ agent, session_id: sessionId, event_id: e.id, event_type: "gateway.error", detail: String(err) });
        continue;
      }
    } else if (contiguous && !(await ctx.db.claimSettled(e.id))) {
      // Another pass may still be handling it, and release it if it fails: keep the
      // bookmark before it until the claim is old enough to be settled.
      contiguous = false;
    }
    if (contiguous) through = e.id;
  }
  if (through && through !== doneThrough) await ctx.db.setEventsDoneThrough(sessionId, through);

  const status = session.status === "idle" ? `idle:${stopReason(events)}` : session.status;
  await ctx.db.updateSession(sessionId, status, costCents(session), sessionTokens(session));

  if (row?.task_id) {
    if (status === "idle:end_turn") await finishTask(ctx, row.task_id, sessionId, "finished");
    else if (status === "idle:budget_reached") await finishTask(ctx, row.task_id, sessionId, "budget");
    else if (session.status === "terminated" || status === "idle:retries_exhausted") await finishTask(ctx, row.task_id, sessionId, "ended");
  }
  // Tell Matt once, when the session first runs out, not on every later pass.
  if (status === "idle:budget_reached" && row?.status !== "idle:budget_reached") {
    await ctx.tg.send(ctx.ownerChatId, `${cap(agent)} hit its session budget and paused (${sessionId}).`);
  }
}

/**
 * A task's session stopped. If it finished its turn, the task is blocked when the
 * session's last status report listed blockers, and Ada is woken to follow it up
 * (decision 50); otherwise it is done, and so is a blocked task it was assigned to
 * follow up. A session that ran out of budget or ended in error leaves its task
 * blocked on that, so Ada decides what happens to it (decision 53). A change task
 * whose change is still building never opened its PR, so it is blocked however its
 * session stopped, and a second such block closes the change (decision 55); one whose PR
 * is open is done, even if its session ran out of budget afterwards (decision 74). Runs on
 * every pass over an idle session, so it acts only when the status changes.
 */
/** Why the gateway left a task blocked, as Ada reads it in get_status. */
export const STOPPED = {
  budget: "Ran out of its session budget before finishing",
  ended: "Session ended in error before finishing",
  idle: "No activity for 7 days; the session is over",
  unstarted: "Never started a session",
};

async function finishTask(ctx: Ctx, taskId: string, sessionId: string, end: "finished" | "budget" | "ended") {
  const task = await ctx.db.getTask(taskId);
  if (!task || ["done", "blocked", "failed", "cancelled"].includes(task.status)) return;
  const change = task.kind === "change" ? await ctx.db.changeForTask(task.id) : null;
  // Each task for a change submits once (C-10): the first opens its PR, a follow-up adds to it or fixes it up.
  const submission = change ? await ctx.db.taskSubmission(task.id) : null;
  const unsubmitted = !!change && !submission && change.state !== "closed";
  // A task that submitted its change is done, whatever stopped the session after.
  const submitted = !!submission;
  let reason = unsubmitted
    ? `${change.id}: no change submitted${{ finished: "", budget: " (budget reached)", ended: " (session ended)" }[end]}`
    : submitted
      ? null
      : { finished: null, budget: STOPPED.budget, ended: STOPPED.ended }[end];
  // For a submitted change, a report from before the PR opened is out of date; one made after still counts.
  const blockers = (await ctx.db.sessionBlockers(sessionId, submission ? submission.created_at : undefined)) ?? [];
  // A review check that finished is judged by whether its review was posted at its head, not by its
  // report (decision 75). Posted: what is left (a maintainer's approval, a refused merge) is the PR's
  // state, and the merge wake re-proposes it once its checks pass, so the task is done. Not posted:
  // it is blocked, whatever the report said.
  if (!reason && task.kind === "review_check" && task.review_target && task.review_sha) {
    if (await ctx.db.reviewedAt(task.review_target, task.review_sha)) {
      await ctx.db.setTask(task.id, "done");
      if (blockers.length) {
        await ctx.db.audit({ agent: task.agent, session_id: sessionId, event_type: "gateway.review_check_done", detail: { task: task.id, blockers: blockers.slice(0, 5) } });
      }
      return;
    }
    reason = `No review posted at ${task.review_sha}`;
  }
  if (reason) blockers.unshift(reason);
  if (blockers.length) {
    await ctx.db.setTask(task.id, "blocked");
    if (reason) await ctx.db.setBlockedReason(task.id, reason);
    await ctx.db.audit({ agent: task.agent, session_id: sessionId, event_type: "gateway.task_blocked", detail: { task: task.id, blockers: blockers.slice(0, 5) } });
    // The second attempt at building a change that ends this way closes it; Ada still puts it to the owner.
    // A follow-up of a change that already has its PR leaves the change as it is.
    if (unsubmitted && task.follows_up && change.state === "building") {
      await ctx.db.updateChange(change.id, { state: "closed", closed_reason: "blocked twice" });
      await ctx.db.audit({ agent: task.agent, session_id: sessionId, event_type: "gateway.change_closed", detail: { change: change.id, reason: "blocked twice" } });
    }
    await wakeAda(ctx, { kind: "task", task, blockers });
    return;
  }
  await ctx.db.setTask(task.id, "done");
  if (task.follows_up?.startsWith("T-")) {
    const original = await ctx.db.getTask(task.follows_up);
    if (original?.status === "blocked") {
      await ctx.db.setTask(original.id, "done");
      await ctx.db.audit({ agent: original.agent, event_type: "gateway.task_unblocked", detail: { task: original.id, by: task.id } });
    }
  }
}

async function handleEvent(
  ctx: Ctx,
  agent: string,
  sessionId: string,
  origin: { chat_id: number | null; discord_user: string | null },
  e: SessionEvent,
) {
  switch (e.type) {
    case "agent.custom_tool_use": {
      // A retry after a failed send resends the answer rather than running the tool again.
      const stored = await ctx.db.toolResult(e.id);
      if (stored !== null) {
        await ctx.managed.sendToolResult(sessionId, e.id, stored);
        return;
      }
      await ctx.db.audit({ agent, session_id: sessionId, event_id: e.id, event_type: e.type, tool: e.name, detail: e.input });
      let result: string;
      try {
        result = await handleTool(ctx, agent, sessionId, e.name ?? "", (e.input ?? {}) as Record<string, unknown>);
      } catch (err) {
        // Always answer: an unanswered tool call leaves the session paused and
        // unable to take new messages. Unexpected failures go to the audit log.
        if (err instanceof ToolDenied) {
          await ctx.db.audit({ agent, session_id: sessionId, event_id: e.id, event_type: "gateway.tool_denied", tool: e.name, permission: "deny", detail: err.message });
        } else if (err instanceof ToolError) {
          await ctx.db.audit({ agent, session_id: sessionId, event_id: e.id, event_type: "gateway.tool_refused", tool: e.name, detail: err.message.slice(0, 300) });
        } else {
          await ctx.db.audit({ agent, session_id: sessionId, event_id: e.id, event_type: "gateway.tool_error", tool: e.name, detail: String(err) });
        }
        result =
          err instanceof ToolError
            ? `Error: ${err.message}`
            : `Error: the gateway could not run ${e.name}: ${err instanceof Error ? err.message : String(err)}. Do not retry blindly; report it in your status.`;
      }
      await ctx.db.saveToolResult(e.id, result);
      await ctx.managed.sendToolResult(sessionId, e.id, result);
      return;
    }

    case "agent.tool_use":
    case "agent.mcp_tool_use": {
      await ctx.db.audit({
        agent,
        session_id: sessionId,
        event_id: e.id,
        event_type: e.type,
        tool: e.name,
        permission: e.evaluated_permission,
        detail: e.input,
      });
      const mcp = e.type === "agent.mcp_tool_use";
      if (e.evaluated_permission === "ask") {
        const d = await ctx.db.createDecision({
          agent,
          kind: "tool.confirm",
          target: e.name ?? "tool",
          summary: `${cap(agent)} wants to run ${e.name}`,
          rationale: "This tool is set to always ask. The session is paused until you decide; the agent's other work is unaffected.",
          risk: "high",
          // An MCP call keeps its server, so approving it can record a GitHub write (C-7).
          payload: mcp ? { input: e.input, mcp_server: typeof e.mcp_server_name === "string" ? e.mcp_server_name : null } : { input: e.input },
          session_id: sessionId,
          tool_use_id: e.id,
        });
        await postDecision(ctx, d);
        return;
      }
      // C-7: only an agent's own GitHub MCP calls are writes; built-in sandbox tools
      // (bash, read, write …) are not. One the permission policy allowed outright has
      // no decision, so its row is flagged. One held for confirmation is recorded when
      // the owner approves it (executeDecision), so a rejected call is never counted.
      const write = mcp && e.evaluated_permission !== "deny" ? mcpGithubWrite(e) : null;
      if (write) await recordGithubWrite(ctx, { agent, sessionId, eventId: e.id, decision: null, ...write });
      return;
    }

    case "agent.message": {
      const text = messageText(e);
      await ctx.db.audit({ agent, session_id: sessionId, event_id: e.id, event_type: e.type, detail: text.slice(0, 500) });
      if (text) await replyToOrigin(ctx, origin, { agent, sessionId }, `${cap(agent)}: ${text}`);
      return;
    }

    case "session.error": {
      await ctx.db.audit({ agent, session_id: sessionId, event_id: e.id, event_type: e.type, detail: e });
      await ctx.tg.send(ctx.ownerChatId, `${cap(agent)} session error (${sessionId}). See audit log.`);
      return;
    }

    default:
      // Keep the audit trail lean: statuses, usage snapshots and tool results are
      // already summarised in the session row.
      if (e.type.startsWith("user.") || e.type === "agent.tool_result" || e.type === "session.usage") return;
      await ctx.db.audit({ agent, session_id: sessionId, event_id: e.id, event_type: e.type });
  }
}

/** Sessions the sweeper processes per run, so a backlog can't exhaust the Worker's subrequests. */
export const SWEEP_LIMIT = 40;

/** Safety net for missed webhooks: re-process sessions that are not finished, least recently updated first. */
export async function sweep(ctx: Ctx, limit = SWEEP_LIMIT) {
  const rows = await ctx.db.sweepableSessions(limit);
  for (const r of rows) {
    try {
      await processSession(ctx, r.id);
    } catch (err) {
      await ctx.db.audit({ agent: r.agent, session_id: r.id, event_type: "gateway.sweep_error", detail: String(err) });
      // The rest would fail the same way; the next run picks them up.
      if (outOfSubrequests(err)) break;
    }
  }
}

/** How long event claims and tool results are kept, and the audit log. */
export const RETENTION = { eventDays: 14, auditDays: 365, staleSessionDays: 7 };

/**
 * The cron's tidying: idle sessions nobody touches go stale, and old rows are pruned.
 * Once an hour, not every five minutes: its thresholds are days, and every run reads rows.
 */
export async function housekeeping(ctx: Ctx, now = new Date()) {
  if (!(await ctx.db.claimEvent(`housekeeping:${now.toISOString().slice(0, 13)}`))) return;
  const stale = await ctx.db.markStaleSessions(RETENTION.staleSessionDays);
  // Decision 53: a task whose session is over without finishing would otherwise stay
  // running for good. Blocked, it waits for Ada's next check-in; no wake for these.
  const blocked = await ctx.db.blockAbandonedTasks(RETENTION.staleSessionDays, STOPPED);
  const pruned = await ctx.db.prune(RETENTION.eventDays, RETENTION.auditDays);
  if (stale || blocked.length || pruned.events || pruned.tool_results || pruned.audit) {
    await ctx.db.audit({ event_type: "gateway.housekeeping", detail: { stale, blocked_tasks: blocked, ...pruned } });
  }
}
