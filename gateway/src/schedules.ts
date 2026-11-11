// Schedules the gateway runs itself (decision 67). Managed Agents deployments accept
// only a plain agent reference, so a schedule that names a task in models.yaml can't
// run there on the task's model and effort. The five-minute cron starts these instead,
// as sessions with the documented per-session model override.

import { AgentUnavailable, startSession, taskModel } from "./agents";
import type { Ctx } from "./context";
import { cronMatches, localTime, parseCron } from "./cron";

/** How far back a cron run looks for a time it hasn't started yet, so a late or missed tick still runs it once. */
export const CATCH_UP_MINUTES = 15;

/**
 * Starts each gateway schedule whose cron time fell in the last CATCH_UP_MINUTES and
 * hasn't been started. Each time is claimed once, so overlapping cron runs start it
 * once. Needs schedules_enabled; a paused or stopped agent's runs are skipped and
 * audited. Never throws.
 */
export async function runSchedules(ctx: Ctx, now = new Date()) {
  const schedules = ctx.network.gateway_schedules ?? [];
  if (!schedules.length || !ctx.network.schedules_enabled) return;
  const minute = Math.floor(now.getTime() / 60_000) * 60_000;
  for (const s of schedules) {
    try {
      const cron = parseCron(s.cron);
      for (let back = CATCH_UP_MINUTES - 1; back >= 0; back--) {
        const t = localTime(ctx.network.timezone, new Date(minute - back * 60_000));
        if (!cronMatches(cron, t)) continue;
        const at = `${t.date}T${t.time}`;
        if (!(await ctx.db.claimEvent(`schedule:${s.name}:${at}`))) continue;
        try {
          const model = taskModel(ctx, s.agent, s.task);
          const sessionId = await startSession(ctx, s.agent, s.prompt, "deployment", "schedule", { budgetCents: s.budget_cents, ...(model ? { model } : {}) });
          await ctx.db.audit({ agent: s.agent, session_id: sessionId, event_type: "gateway.schedule_started", detail: { schedule: s.name, at, task: s.task } });
        } catch (err) {
          const why = err instanceof AgentUnavailable ? err.message : `error: ${err instanceof Error ? err.message : String(err)}`;
          await ctx.db.audit({ agent: s.agent, event_type: "gateway.schedule_skipped", detail: { schedule: s.name, at, why } });
        }
      }
    } catch (err) {
      await ctx.db.audit({ agent: s.agent, event_type: "gateway.schedule_error", detail: { schedule: s.name, error: String(err) } }).catch(() => undefined);
    }
  }
}
