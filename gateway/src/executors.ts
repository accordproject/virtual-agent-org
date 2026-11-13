// Executes approved decisions. Each kind's checks and execution live in actions.ts;
// critical credentials live there, never in agent sandboxes.

import { executeAction, type ExecResult } from "./actions";
import type { Ctx } from "./context";
import type { Decision } from "./db";
import { decisionArgs, recordGithubWrite } from "./githubWrites";

export { inScope, isGuidanceFile, type ExecResult } from "./actions";
export { ciSensitivePaths } from "./review";

/**
 * Runs a decision. A GitHub kind's run gets a `github.write` audit row (C-7): authorised
 * by the decision, or, when `internal` gives the reason, by the gateway's own rule for
 * an auto kind, with the decision kept as its record.
 */
export async function executeDecision(ctx: Ctx, d: Decision, internal?: string): Promise<ExecResult> {
  const writes = !ctx.dryRun && ctx.network.action_kinds[d.kind]?.executor === "github";
  let ok = false;
  try {
    const r = await executeAction(ctx, d);
    ok = r.ok;
    return r;
  } finally {
    if (writes) {
      await recordGithubWrite(ctx, {
        agent: d.agent,
        sessionId: d.session_id,
        tool: d.kind,
        ...(internal ? { internal, record: d.id } : { decision: d.id }),
        ...decisionArgs(d),
        ok,
      });
    }
  }
}
