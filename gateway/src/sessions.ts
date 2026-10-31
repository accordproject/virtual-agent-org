// Processes a Managed Agents session after a webhook (or the sweeper) says it changed:
// audits every event, answers custom tool calls, turns paused tool calls into
// decisions, and forwards agent replies to Telegram.

import { postDecision, replyToOrigin } from "./agents";
import { agentByManagedId } from "./config";
import { cap, type Ctx } from "./context";
import { costCents, messageText, sessionAgentId, type SessionEvent } from "./managed";
import { ToolError, handleTool } from "./tools";

export async function processSession(ctx: Ctx, sessionId: string): Promise<void> {
  const session = await ctx.managed.retrieveSession(sessionId);
  let row = await ctx.db.getSession(sessionId);
  const agent = row?.agent ?? agentByManagedId(sessionAgentId(session) ?? "", ctx.deployed);
  if (!agent) {
    await ctx.db.audit({ session_id: sessionId, event_type: "gateway.unknown_session", detail: { agent: session.agent } });
    return;
  }
  if (!row) {
    await ctx.db.upsertSession({ id: sessionId, agent, origin: "deployment" });
    row = await ctx.db.getSession(sessionId);
  }

  const events = await ctx.managed.listEvents(sessionId);
  for (const e of events) {
    if (!(await ctx.db.claimEvent(e.id))) continue;
    try {
      await handleEvent(ctx, agent, sessionId, { chat_id: row?.chat_id ?? null, discord_user: row?.discord_user ?? null }, e);
    } catch (err) {
      // Let the sweeper retry this event later.
      await ctx.db.releaseEvent(e.id);
      await ctx.db.audit({ agent, session_id: sessionId, event_id: e.id, event_type: "gateway.error", detail: String(err) });
    }
  }

  const status = session.status === "idle" ? `idle:${session.stop_reason?.type ?? ""}` : session.status;
  await ctx.db.updateSession(sessionId, status, costCents(session));

  if (row?.task_id && session.status === "idle" && session.stop_reason?.type === "end_turn") {
    await ctx.db.setTask(row.task_id, "done");
  }
  if (session.status === "idle" && session.stop_reason?.type === "budget_reached") {
    await ctx.tg.send(ctx.ownerChatId, `${cap(agent)} hit its session budget and paused (${sessionId}).`);
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
      await ctx.db.audit({ agent, session_id: sessionId, event_id: e.id, event_type: e.type, tool: e.name, detail: e.input });
      let result: string;
      try {
        result = await handleTool(ctx, agent, sessionId, e.name ?? "", (e.input ?? {}) as Record<string, unknown>);
      } catch (err) {
        // Always answer: an unanswered tool call leaves the session paused and
        // unable to take new messages. Unexpected failures go to the audit log.
        if (!(err instanceof ToolError)) {
          await ctx.db.audit({ agent, session_id: sessionId, event_id: e.id, event_type: "gateway.tool_error", tool: e.name, detail: String(err) });
        }
        result =
          err instanceof ToolError
            ? `Error: ${err.message}`
            : `Error: the gateway could not run ${e.name}: ${err instanceof Error ? err.message : String(err)}. Do not retry blindly; report it in your status.`;
      }
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
      if (e.evaluated_permission === "ask") {
        const d = await ctx.db.createDecision({
          agent,
          kind: "tool.confirm",
          target: e.name ?? "tool",
          summary: `${cap(agent)} wants to run ${e.name}`,
          rationale: "This tool is set to always ask. The session is paused until you decide; the agent's other work is unaffected.",
          risk: "high",
          payload: { input: e.input },
          session_id: sessionId,
          tool_use_id: e.id,
        });
        await postDecision(ctx, d);
      }
      return;
    }

    case "agent.message": {
      const text = messageText(e);
      await ctx.db.audit({ agent, session_id: sessionId, event_id: e.id, event_type: e.type, detail: text.slice(0, 500) });
      if (text) await replyToOrigin(ctx, origin, `${cap(agent)}: ${text}`);
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

/** Safety net for missed webhooks: re-process sessions that are not finished. */
export async function sweep(ctx: Ctx) {
  const rows = await ctx.db.activeSessions();
  for (const r of rows) {
    if (r.status.startsWith("idle:end_turn") || r.status === "terminated") continue;
    try {
      await processSession(ctx, r.id);
    } catch (err) {
      await ctx.db.audit({ agent: r.agent, session_id: r.id, event_type: "gateway.sweep_error", detail: String(err) });
    }
  }
}
