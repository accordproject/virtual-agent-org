// Handlers for the custom tools agents call. The gateway is the enforcement point:
// it checks who may call what before doing anything.

import { AgentUnavailable, postDecision, startSession } from "./agents";
import { cap, type Ctx } from "./context";
import { ciSensitivePaths, executeDecision, inScope } from "./executors";
import { parseTarget } from "./github";
import { ADA_TOOLS, COMMON_TOOLS, MIRA_TOOLS, OTTO_TOOLS, VERA_TOOLS } from "./toolDefs";
import { isTechWg } from "./vimeo";

const RISK_ORDER = ["low", "medium", "high"];
const maxRisk = (a: string, b: string) => (RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b);

const OWNERS: Record<string, string | undefined> = {
  ...Object.fromEntries(COMMON_TOOLS.map((t) => [t.name, undefined])),
  ...Object.fromEntries(ADA_TOOLS.map((t) => [t.name, "ada"])),
  ...Object.fromEntries(VERA_TOOLS.map((t) => [t.name, "vera"])),
  ...Object.fromEntries(OTTO_TOOLS.map((t) => [t.name, "otto"])),
  ...Object.fromEntries(MIRA_TOOLS.map((t) => [t.name, "mira"])),
};

export class ToolError extends Error {}

type Input = Record<string, unknown>;

const s = (v: unknown, field: string, required = true): string => {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (required) throw new ToolError(`${field} is required`);
  return "";
};
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);

export async function handleTool(ctx: Ctx, agent: string, sessionId: string, name: string, input: Input): Promise<string> {
  if (!(name in OWNERS)) throw new ToolError(`Unknown tool ${name}`);
  const owner = OWNERS[name];
  if (owner && owner !== agent) throw new ToolError(`${name} is not available to ${agent}`);

  const status = await ctx.db.agentStatus(agent);
  if (status === "stopped" || status === "revoked") {
    throw new ToolError(`You have been ${status} by the owner. Stop work and end the session.`);
  }

  switch (name) {
    case "request_action":
      return requestAction(ctx, agent, sessionId, input);

    case "request_review_check":
      return requestReviewCheck(ctx, sessionId, input);

    case "report_status":
      await ctx.db.addStatus({
        agent,
        session_id: sessionId,
        done: list(input.done),
        doing: list(input.doing),
        blocked: list(input.blocked),
        notes: typeof input.notes === "string" ? input.notes : undefined,
      });
      return "Status recorded.";

    case "get_decisions": {
      const status = (input.status as "open" | "decided" | "all") ?? "all";
      const ds = await ctx.db.listDecisions({ status, agent });
      return JSON.stringify(
        ds.map((d) => ({ id: d.id, kind: d.kind, target: d.target, summary: d.summary, status: d.status, note: d.note, result: d.result })),
      );
    }

    case "assign_task":
      return assignTask(ctx, input);

    case "get_status": {
      const who = typeof input.agent === "string" && input.agent ? input.agent.toLowerCase() : undefined;
      const [statuses, tasks, controls] = await Promise.all([
        ctx.db.latestStatuses(who),
        ctx.db.openTasks(who),
        ctx.db.allAgentStatuses(),
      ]);
      const active = Object.values(ctx.network.agents)
        .filter((a) => a.phase <= ctx.network.current_phase)
        .map((a) => a.name);
      return JSON.stringify({ active_agents: active, controls, statuses, open_tasks: tasks });
    }

    case "get_scorecard": {
      const sc = await ctx.db.getScorecard(typeof input.period === "string" ? input.period : undefined);
      return sc ? JSON.stringify(sc) : "No scorecard yet.";
    }

    case "list_decisions": {
      const ds = await ctx.db.listDecisions({ status: (input.status as "open" | "decided" | "all") ?? "open" });
      return JSON.stringify(
        ds.map((d) => ({
          id: d.id, agent: d.agent, kind: d.kind, summary: d.summary, risk: d.risk, status: d.status, note: d.note, created_at: d.created_at,
        })),
      );
    }

    case "record_evaluation": {
      const target = s(input.agent, "agent").toLowerCase();
      if (!ctx.network.agents[target]) throw new ToolError(`No agent called ${target}`);
      await ctx.db.putEvaluation({
        agent: target,
        week: s(input.week, "week"),
        scores: input.scores,
        evidence: s(input.evidence, "evidence"),
        proposal: typeof input.proposal === "string" ? input.proposal : undefined,
      });
      return `Evaluation for ${target} recorded.`;
    }

    case "send_to_matt": {
      const text = s(input.text, "text");
      await ctx.tg.send(ctx.ownerChatId, text);
      return "Sent.";
    }

    case "vimeo_recordings": {
      const limit = typeof input.limit === "number" ? input.limit : 15;
      const videos = await ctx.vimeo().recent(limit);
      return JSON.stringify(
        videos.map((v) => ({
          ...v,
          description: v.description ? v.description.slice(0, 300) : null,
          tech_wg: isTechWg(v.name),
          processed: !!v.description,
        })),
      );
    }

    case "vimeo_transcript": {
      const id = s(input.video_id, "video_id");
      const offset = typeof input.offset === "number" && input.offset > 0 ? Math.floor(input.offset) : 0;
      const text = await ctx.vimeo().transcript(id);
      const PAGE = 60_000;
      let end = Math.min(offset + PAGE, text.length);
      if (end < text.length) end = text.lastIndexOf("\n", end) > offset ? text.lastIndexOf("\n", end) : end;
      return JSON.stringify({
        video_id: id,
        total_chars: text.length,
        offset,
        next_offset: end < text.length ? end + 1 : null,
        text: text.slice(offset, end),
      });
    }

    case "write_scorecard": {
      const period = s(input.period, "period");
      if (!input.scorecard || typeof input.scorecard !== "object") throw new ToolError("scorecard must be an object");
      await ctx.db.putScorecard(period, input.scorecard);
      return `Scorecard ${period} stored.`;
    }
  }
  throw new ToolError(`Unhandled tool ${name}`);
}

async function requestAction(ctx: Ctx, agent: string, sessionId: string, input: Input): Promise<string> {
  const kind = s(input.kind, "kind");
  const allowed = ctx.network.agents[agent]?.requestable ?? [];
  if (!allowed.includes(kind)) {
    throw new ToolError(`You may not request ${kind}. Allowed: ${allowed.join(", ") || "none"}.`);
  }
  const declared = typeof input.risk === "string" && RISK_ORDER.includes(input.risk) ? input.risk : "high";
  const floor = ctx.network.action_kinds[kind]?.risk ?? "high";
  if (kind === "github.merge" && agent === "mira" && ctx.network.review_check_required && !(await isReviewCheck(ctx, sessionId))) {
    throw new ToolError("Merge proposals come from the review check. Call request_review_check with your draft review instead.");
  }
  if (ctx.network.action_kinds[kind]?.auto && kind === "github.approve_ci" && declared !== "high") {
    return autoApproveCi(ctx, agent, sessionId, input);
  }
  const d = await ctx.db.createDecision({
    agent,
    kind,
    target: s(input.target, "target"),
    summary: s(input.summary, "summary").slice(0, 200),
    rationale: s(input.rationale, "rationale"),
    risk: maxRisk(declared, floor),
    payload: input.payload ?? {},
    session_id: sessionId,
  });
  await postDecision(ctx, d);
  return `Queued as ${d.id}. Do not wait for it: continue with other work. Check the outcome later with get_decisions.`;
}

/**
 * github.approve_ci without Matt: the gateway checks the PR itself and only goes
 * ahead when nothing in it changes what CI runs or installs. Otherwise it queues
 * the request for Matt as high risk. Either way there is a decision record.
 */
async function autoApproveCi(ctx: Ctx, agent: string, sessionId: string, input: Input): Promise<string> {
  const target = s(input.target, "target");
  const ref = parseTarget(target);
  if (!ref?.number) throw new ToolError("target must be a pull request, e.g. accordproject/concerto#123");
  if (!inScope(ctx, ref)) throw new ToolError(`${ref.owner}/${ref.repo} is not in the configured repos`);
  const payload = (input.payload && typeof input.payload === "object" ? input.payload : {}) as Input;
  if (typeof payload.sha !== "string" || payload.sha.length < 7) {
    throw new ToolError("payload.sha is required: the head commit you reviewed (at least 7 characters)");
  }
  const gh = await ctx.github();
  const files = await gh.pullFiles(ref as Required<typeof ref>);
  const risky = ciSensitivePaths(files);
  const base = {
    agent,
    kind: "github.approve_ci",
    target,
    summary: s(input.summary, "summary").slice(0, 200),
    rationale: s(input.rationale, "rationale"),
    payload,
    session_id: sessionId,
  };
  if (risky.length) {
    const shown = risky.slice(0, 8).join(", ") + (risky.length > 8 ? ` and ${risky.length - 8} more` : "");
    const d = await ctx.db.createDecision({ ...base, risk: "high", rationale: `${base.rationale}\n\nNot approved automatically: the PR changes ${shown}.` });
    await postDecision(ctx, d);
    return `Queued for Matt as ${d.id}: the PR changes files CI runs or installs (${shown}). Continue with other work.`;
  }
  const d = await ctx.db.createDecision({ ...base, risk: "low" });
  await ctx.db.decide(d.id, "approved", "approved automatically: no workflow, build or dependency files changed");
  const r = await executeDecision(ctx, { ...d, status: "approved" }).catch((e) => ({ ok: false, result: e instanceof Error ? e.message : String(e) }));
  await ctx.db.markExecuted(d.id, r.ok, r.result);
  await ctx.db.audit({ agent, session_id: sessionId, event_type: "gateway.auto_executed", detail: { id: d.id, kind: d.kind, target, ok: r.ok, result: r.result } });
  return `${d.id} ${r.ok ? "done" : "failed"}: ${r.result}`;
}

/** Session budget and tool-call guidance for each effort level (decision 1B). */
export const EFFORT: Record<string, { cents: number; calls: string }> = {
  small: { cents: 30, calls: "about 10 tool calls" },
  medium: { cents: 100, calls: "about 30 tool calls" },
  large: { cents: 300, calls: "about 80 tool calls" },
};

async function assignTask(ctx: Ctx, input: Input): Promise<string> {
  const agent = s(input.agent, "agent").toLowerCase();
  if (agent === "ada") throw new ToolError("Ada cannot assign tasks to herself.");
  const title = s(input.title, "title");
  const objective = s(input.objective, "objective");
  const output = s(input.output, "output");
  const doneWhen = s(input.done_when, "done_when");
  const effort = typeof input.effort === "string" && EFFORT[input.effort] ? input.effort : "";
  if (!effort) throw new ToolError("effort must be small, medium or large");
  const boundaries = s(input.boundaries, "boundaries", false);
  const context = s(input.context, "context", false) || s(input.brief, "brief", false);
  const priority = typeof input.priority === "string" ? input.priority : "normal";
  const due = typeof input.due === "string" ? input.due : undefined;
  const { cents, calls } = EFFORT[effort];

  const brief = [
    `Objective: ${objective}`,
    `Hand back: ${output}`,
    `Done when: ${doneWhen}`,
    ...(boundaries ? [`Out of scope: ${boundaries}`] : []),
    `Effort: ${effort}. Aim for ${calls}; the session stops at $${(cents / 100).toFixed(2)}. Stop as soon as "done when" is met.`,
    ...(context ? ["", `Context: ${context}`] : []),
  ].join("\n");

  const task = await ctx.db.createTask({ agent, title, brief, priority, due });
  try {
    const text = [
      `Task ${task.id} from Ada (priority: ${priority}${due ? `, due ${due}` : ""})`,
      `Title: ${title}`,
      "",
      brief,
      "",
      "When finished, call report_status. Queue any critical action with request_action and continue.",
    ].join("\n");
    const sessionId = await startSession(ctx, agent, text, "task", { taskId: task.id, budgetCents: cents });
    await ctx.db.setTask(task.id, "running", sessionId);
    return `Assigned ${task.id} to ${cap(agent)} (${effort} effort, $${(cents / 100).toFixed(2)} cap).`;
  } catch (e) {
    await ctx.db.setTask(task.id, "failed");
    if (e instanceof AgentUnavailable) throw new ToolError(`${task.id} not started: ${e.message}`);
    throw e;
  }
}

const CHECK_PREFIX = "Review check: ";

async function isReviewCheck(ctx: Ctx, sessionId: string): Promise<boolean> {
  const t = await ctx.db.sessionTask(sessionId);
  return !!t && t.agent === "mira" && t.title.startsWith(CHECK_PREFIX);
}

/**
 * Decision 2A: a draft review goes to a fresh Mira session that has not seen the
 * reasoning behind it. That session verifies each finding against the code, posts
 * only what it confirms, and is the only place a merge proposal may come from.
 */
async function requestReviewCheck(ctx: Ctx, sessionId: string, input: Input): Promise<string> {
  if (await isReviewCheck(ctx, sessionId)) throw new ToolError("You are the review check: finish the check yourself.");
  const target = s(input.target, "target");
  const ref = parseTarget(target);
  if (!ref?.number) throw new ToolError("target must be a pull request, e.g. accordproject/concerto#123");
  if (!inScope(ctx, ref)) throw new ToolError(`${ref.owner}/${ref.repo} is not in the configured repos`);
  const sha = s(input.sha, "sha");
  if (sha.length < 7) throw new ToolError("sha must be at least 7 characters");
  const draft = s(input.draft, "draft");
  const lines = Number(input.changed_lines) || 0;
  const large = lines > 200;
  const model = large ? ctx.network.model_tiers?.deep : undefined;

  const brief = [
    `You are checking a review of ${target} at ${sha.slice(0, 7)} in a fresh session. Another session wrote the draft below;`,
    "treat it as claims to verify, not conclusions. Read the repo's AGENTS.md and CONTRIBUTING.md and your /notes/repos notes first.",
    "",
    "1. For each finding, open the code at that commit and confirm it. Drop anything you cannot confirm or that is only style",
    "   the linter or CI already covers. Keep at most three nits.",
    "2. Look once more for blocking problems the draft missed: correctness, breaking API changes, security, missing tests.",
    "3. If the head commit is no longer the one reviewed, stop and say so in report_status.",
    "4. Post one review: a short summary comment plus inline comments for confirmed findings, each labelled",
    "   blocking, should-fix or nit. Be kind and specific; say what would make it mergeable.",
    "5. Only if nothing blocking remains, CI is green, a maintainer has approved and no threads are unresolved, queue",
    "   request_action(kind=\"github.merge\") with a rationale that cites the checks and your verification.",
    "6. Append each posted finding to /notes/review-ledger.md: date, PR, file:line, severity, one line. Leave its outcome blank.",
    "",
    `Draft review (${lines} changed lines):`,
    draft,
  ].join("\n");

  const task = await ctx.db.createTask({ agent: "mira", title: `${CHECK_PREFIX}${target}@${sha.slice(0, 7)}`, brief });
  try {
    const sid = await startSession(ctx, "mira", brief, "task", { taskId: task.id, budgetCents: large ? 300 : 150, ...(model ? { model } : {}) });
    await ctx.db.setTask(task.id, "running", sid);
    return `Review check ${task.id} started${model ? " on the deep tier" : ""}. Do not post this review or propose the merge yourself; move on.`;
  } catch (e) {
    await ctx.db.setTask(task.id, "failed");
    if (e instanceof AgentUnavailable) throw new ToolError(`${task.id} not started: ${e.message}`);
    throw e;
  }
}
