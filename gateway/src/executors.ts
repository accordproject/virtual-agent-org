// Executes approved decisions. Each kind's checks and execution live in actions.ts;
// critical credentials live there, never in agent sandboxes.

import { executeAction, type ExecResult } from "./actions";
import type { Ctx } from "./context";
import type { Decision } from "./db";

export { inScope, isGuidanceFile, type ExecResult } from "./actions";
export { ciSensitivePaths } from "./review";

export function executeDecision(ctx: Ctx, d: Decision): Promise<ExecResult> {
  return executeAction(ctx, d);
}
