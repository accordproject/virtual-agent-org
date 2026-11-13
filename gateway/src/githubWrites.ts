// Who wrote to GitHub, and on whose authority (C-7). Every GitHub write gets one
// `github.write` audit row: the calling agent, session and task, the decision that
// authorised it or "gateway-internal" with the reason, and a short summary of the
// arguments. A write with neither a decision nor a gateway reason is flagged, so
// Vera's read_audit shows it for checking.

import type { Ctx } from "./context";
import type { Decision } from "./db";
import { parseTarget } from "./github";

/** What authorised a write that no decision covers: the gateway's own rule for it. */
export const INTERNAL = "gateway-internal";

/** Why the gateway runs each auto kind without Matt, as a write row's reason. */
const AUTO_REASONS: Record<string, string> = {
  "github.review": "review post",
  "github.approve_ci": "CI approval",
  "github.rerun_ci": "CI re-run",
};

export function autoReason(kind: string): string {
  return AUTO_REASONS[kind] ?? `auto ${kind}`;
}

export interface GithubWrite {
  agent?: string | null;
  sessionId?: string | null;
  /** Looked up from the session when not given. */
  taskId?: string | null;
  eventId?: string;
  /** The MCP tool, action kind or gateway tool that wrote. */
  tool: string;
  /** The decision that authorised the write. */
  decision?: string | null;
  /** Set instead of `decision` when the gateway wrote on its own rules. */
  internal?: string;
  /** The decision record an auto kind keeps, though nobody decided it. */
  record?: string;
  repo: string | null;
  number: number | null;
  fields: string[];
  ok?: boolean;
}

/** Records one write. Never throws: a write that happened must not be reported as failed. */
export async function recordGithubWrite(ctx: Ctx, w: GithubWrite): Promise<void> {
  try {
    const task = w.taskId ?? (w.sessionId ? ((await ctx.db.getSession(w.sessionId))?.task_id ?? null) : null);
    const decision = w.decision || (w.internal ? INTERNAL : null);
    await ctx.db.audit({
      agent: w.agent ?? undefined,
      session_id: w.sessionId ?? undefined,
      event_id: w.eventId,
      event_type: "github.write",
      tool: w.tool,
      detail: {
        task,
        decision,
        ...(w.internal && !w.decision ? { reason: w.internal } : {}),
        ...(w.record ? { record: w.record } : {}),
        args: { repo: w.repo, number: w.number, fields: w.fields },
        ...(w.ok === undefined ? {} : { ok: w.ok }),
        ...(decision ? {} : { flagged: "no decision and no gateway reason" }),
      },
    });
  } catch (e) {
    await ctx.db.audit({ agent: w.agent ?? undefined, session_id: w.sessionId ?? undefined, event_type: "gateway.github_write_audit_error", tool: w.tool, detail: String(e) }).catch(() => undefined);
  }
}

// ---- GitHub MCP tools -------------------------------------------------------

/** GitHub MCP tools that only read: get_*, list_*, search_* and *_read (but not mark_*_read). */
const MCP_READ = /^(get|list|search)_|^(?!mark_)\w+_read$/;
/** The arguments that say where a write went, rather than what it changed. */
const WHERE = new Set(["owner", "repo", "pullNumber", "pull_number", "issue_number", "issueNumber", "number"]);

/** The server and bare tool name of an MCP call, from the event or a `mcp__<server>__<tool>` name. */
function mcpName(e: { name?: string; [k: string]: unknown }): { server: string | null; tool: string } {
  const name = e.name ?? "";
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  const server = typeof e.mcp_server_name === "string" ? e.mcp_server_name : (m?.[1] ?? null);
  return { server, tool: m ? m[2] : name };
}

/**
 * An agent's GitHub MCP call, as a write, or null when it only reads or isn't GitHub.
 * A call that names no server is taken as GitHub, so a write is never missed.
 */
export function mcpGithubWrite(e: { name?: string; input?: Record<string, unknown>; [k: string]: unknown }): Pick<GithubWrite, "tool" | "repo" | "number" | "fields"> | null {
  const { server, tool } = mcpName(e);
  if ((server !== null && server !== "github") || !tool || MCP_READ.test(tool)) return null;
  const input = e.input ?? {};
  const repo = typeof input.owner === "string" && typeof input.repo === "string" ? `${input.owner}/${input.repo}` : null;
  const n = Number(input.pullNumber ?? input.pull_number ?? input.issue_number ?? input.issueNumber ?? input.number);
  return { tool, repo, number: Number.isInteger(n) && n > 0 ? n : null, fields: Object.keys(input).filter((k) => !WHERE.has(k)) };
}

/** The repo, number and payload fields of a decision, for its write row. */
export function decisionArgs(d: Pick<Decision, "target" | "payload">): Pick<GithubWrite, "repo" | "number" | "fields"> {
  const ref = parseTarget(d.target);
  let fields: string[] = [];
  try {
    const p = typeof d.payload === "string" ? JSON.parse(d.payload) : d.payload;
    if (p && typeof p === "object" && !Array.isArray(p)) fields = Object.keys(p);
  } catch {
    // An unreadable payload still gets its row, without fields.
  }
  return { repo: ref ? `${ref.owner}/${ref.repo}` : null, number: ref?.number ?? null, fields };
}
