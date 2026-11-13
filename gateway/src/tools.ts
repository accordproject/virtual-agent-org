// Handlers for the custom tools agents call. The gateway is the enforcement point:
// it checks who may call what before doing anything.

import { ActionInvalid, DEPENDENCY_FILE, actionRisk, isDependencyBot, safeJson, validateAction, type Normalised } from "./actions";
import { AgentUnavailable, postDecision, refreshDecisionCard, resendDecisionCard, sendAgentMessage, startSession, taskModel } from "./agents";
import { PR_HISTORY, addMonths, communityStats, iso, startOfDay } from "./community";
import { changeBudget, missingEvidence, proposalGuard, repeatEvidence, submitChange } from "./changes";
import { cap, type Ctx } from "./context";
import type { Change, Decision, StartedBy } from "./db";
import { ciSensitivePaths, executeDecision, inScope } from "./executors";
import { parseTarget, type RepoRef } from "./github";
import { ACTIVITY_DAYS, activityLine, requestCiFix } from "./githubEvents";
import { autoReason, recordGithubWrite } from "./githubWrites";
import { memberOf } from "./people";
import {
  GATEWAY_LABEL, KIND_LABELS, checklist, ciApprovalRisks, failed, mergeCard, mergeChecks, parseFindings, prFacts, publicTextProblems, queueFrom, renderReview, reviewConfig, reviewLabels, type PrFacts, type ReviewFinding,
} from "./review";
import { maxRisk, toRisk, type Risk } from "./risk";
import { schemaProblems } from "./schema";
import { MAX_DOCUMENT_CHARS, MAX_RESENT_CARDS, READS_ALL_DECISIONS, TOOLS, isToolName, type ToolName, type ToolSpec } from "./toolDefs";
import { isTechWg } from "./vimeo";

export class ToolError extends Error {}
/** A refusal on permission grounds rather than bad input; the audit log records these. */
export class ToolDenied extends ToolError {}

type Input = Record<string, unknown>;

const s = (v: unknown, field: string, required = true): string => {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (required) throw new ToolError(`${field} is required`);
  return "";
};
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);

/** One tool call: who made it, from which session, with what input (already checked against the tool's schema). */
interface Call {
  agent: string;
  sessionId: string;
  input: Input;
}

type Handler = (ctx: Ctx, call: Call) => Promise<string>;

export async function handleTool(ctx: Ctx, agent: string, sessionId: string, name: string, input: Input): Promise<string> {
  if (!isToolName(name)) throw new ToolError(`Unknown tool ${name}`);
  const spec: ToolSpec = TOOLS[name];
  if (spec.owner && spec.owner !== agent) throw new ToolDenied(`${name} is not available to ${agent}`);

  const status = await ctx.db.agentStatus(agent);
  if (status === "stopped" || status === "revoked") {
    throw new ToolDenied(`You have been ${status} by the owner. Stop work and end the session.`);
  }

  const problems = schemaProblems(spec.input_schema, input);
  if (problems.length) throw new ToolError(`Fix the input and call again:\n- ${problems.join("\n- ")}`);
  return HANDLERS[name](ctx, { agent, sessionId, input });
}

/** Every tool in toolDefs.ts has exactly one handler here; the type checker enforces it. */
const HANDLERS: Record<ToolName, Handler> = {
  request_action: (ctx, { agent, sessionId, input }) => requestAction(ctx, agent, sessionId, input),

  request_review_check: (ctx, { sessionId, input }) => requestReviewCheck(ctx, sessionId, input),

  submit_review: (ctx, { sessionId, input }) => submitReview(ctx, sessionId, input),

  request_ci_fix: async (ctx, { sessionId, input }) => {
    const member = await sessionMember(ctx, sessionId);
    // A fix ends in a PR or a public comment: that is acting, not answering.
    if (member) throw new ToolError(`${member.name} is a member: they can ask about a PR's CI, not set a fix going. Answer them.`);
    const ref = prRef(ctx, input.target);
    const out = await requestCiFix(ctx, ref, s(input.sha, "sha"), s(input.diagnosis, "diagnosis"));
    if ("refused" in out) throw new ToolError(out.refused);
    return out.queued;
  },

  submit_change: (ctx, { agent, sessionId, input }) => submitChange(ctx, agent, sessionId, input),

  pr_facts: async (ctx, { input }) => {
    const ref = prRef(ctx, input.target);
    const f = await prFacts(ctx, ref);
    const review = await ctx.db.latestReview(f.target);
    return JSON.stringify({
      ...f,
      files: f.files.slice(0, 200),
      last_review: review ? { id: review.id, sha: review.sha, verdict: review.verdict, at_head: review.sha === f.sha, url: review.url } : null,
      merge_checks: checklist(mergeChecks(f, f.sha, review?.sha === f.sha ? review : null)),
      review_areas: reviewConfig(ctx).areas,
    });
  },

  label_pr: (ctx, { agent, sessionId, input }) => labelPr(ctx, agent, sessionId, input),

  pr_queue: async (ctx, { input }) => {
    const repo = s(input.repo, "repo");
    const ref = parseTarget(repo);
    if (!ref || ref.number) throw new ToolError("repo must be owner/name, e.g. accordproject/concerto");
    if (!inScope(ctx, ref)) throw new ToolError(`${repo} is not in the configured repos`);
    const name = `${ref.owner}/${ref.repo}`;
    const gh = await ctx.github();
    const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().replace("T", " ").slice(0, 19);
    const [pulls, reviewed, events, woken] = await Promise.all([
      gh.openPulls(ref),
      ctx.db.reviewedHeads(name),
      ctx.db.githubActivity(name, ago(ACTIVITY_DAYS)),
      ctx.db.reviewWokenHeads(name, ago(1)),
    ]);
    // Decision 62: what moved on each PR lately, and whether a review wake started on its
    // current head in the last day. Only that marks it as handled: a first response, an
    // older head or a wake from days ago leaves it to the catch-up pass.
    return JSON.stringify(
      queueFrom(name, pulls, reviewed).map((p) => {
        const activity = activityLine(events.filter((e) => e.target === p.target.toLowerCase()));
        return { ...p, ...(activity ? { activity } : {}), ...(woken.has(`${p.target.toLowerCase()}@${p.sha}`) ? { review_woken_at_head: true } : {}) };
      }),
    );
  },

  review_findings: async (ctx, { input }) => {
    const status = input.status === "all" ? "all" : "open";
    const repo = s(input.repo, "repo", false) || undefined;
    const days = typeof input.days === "number" && input.days > 0 ? Math.floor(input.days) : undefined;
    const [findings, stats] = await Promise.all([ctx.db.listFindings({ open: status === "open", repo, days }), ctx.db.reviewStats(days ?? 90)]);
    return JSON.stringify({ stats, findings });
  },

  record_finding_outcome: async (ctx, { input }) => {
    const id = s(input.id, "id");
    const outcome = s(input.outcome, "outcome");
    if (!["acted", "dismissed"].includes(outcome)) throw new ToolError("outcome must be acted or dismissed");
    if (!(await ctx.db.setFindingOutcome(id, outcome, s(input.note, "note", false) || undefined))) throw new ToolError(`No finding ${id}`);
    return `${id.toUpperCase()}: ${outcome}.`;
  },

  record_review_outcome: async (ctx, { input }) => {
    const target = s(input.target, "target");
    const outcome = s(input.outcome, "outcome");
    if (!["merged", "closed", "reverted", "follow_up"].includes(outcome)) throw new ToolError("outcome must be merged, closed, reverted or follow_up");
    const ref = prRef(ctx, target);
    if (!(await ctx.db.setReviewOutcome(`${ref.owner}/${ref.repo}#${ref.number}`, outcome, s(input.note, "note", false) || undefined))) {
      throw new ToolError(`${target} has no posted review`);
    }
    return `Recorded ${outcome} for ${target}.`;
  },

  report_status: async (ctx, { agent, sessionId, input }) => {
    await ctx.db.addStatus({
      agent,
      session_id: sessionId,
      done: list(input.done),
      doing: list(input.doing),
      blocked: list(input.blocked),
      notes: typeof input.notes === "string" ? input.notes : undefined,
    });
    return "Status recorded.";
  },

  get_decisions: async (ctx, { agent, input }) => {
    const status = (input.status as "open" | "decided" | "all") ?? "all";
    if (READS_ALL_DECISIONS.includes(agent)) {
      const ds = await ctx.db.listDecisions({ status });
      return JSON.stringify(
        ds.map((d) => ({
          id: d.id, agent: d.agent, kind: d.kind, target: d.target, summary: d.summary, status: d.status, note: d.note, result: d.result,
          created_at: d.created_at, decided_at: d.decided_at,
        })),
      );
    }
    const ds = await ctx.db.listDecisions({ status, agent });
    return JSON.stringify(
      ds.map((d) => ({ id: d.id, kind: d.kind, target: d.target, summary: d.summary, status: d.status, note: d.note, result: d.result })),
    );
  },

  assign_task: (ctx, { sessionId, input }) => assignTask(ctx, sessionId, input),

  get_status: async (ctx, { input }) => {
    const who = typeof input.agent === "string" && input.agent ? input.agent.toLowerCase() : undefined;
    const fortnightAgo = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
    const [statuses, tasks, controls, changes] = await Promise.all([
      ctx.db.latestStatuses(who),
      ctx.db.openTasks(who),
      ctx.db.allAgentStatuses(),
      ctx.db.recentChanges(fortnightAgo, who),
    ]);
    const active = Object.values(ctx.network.agents)
      .filter((a) => a.phase <= ctx.network.current_phase)
      .map((a) => a.name);
    return JSON.stringify({ active_agents: active, controls, statuses, open_tasks: tasks, changes: changes.map(changeView) });
  },

  get_scorecard: async (ctx, { input }) => {
    const sc = await ctx.db.getScorecard(typeof input.period === "string" ? input.period : undefined);
    return sc ? JSON.stringify(sc) : "No scorecard yet.";
  },

  list_decisions: async (ctx, { input }) => {
    const ds = await ctx.db.listDecisions({ status: (input.status as "open" | "decided" | "all") ?? "open" });
    return JSON.stringify(
      ds.map((d) => ({
        id: d.id, agent: d.agent, kind: d.kind, summary: d.summary, risk: d.risk, status: d.status, note: d.note, created_at: d.created_at,
      })),
    );
  },

  decide_action: (ctx, { sessionId, input }) => decideAction(ctx, sessionId, input),

  close_task: (ctx, { sessionId, input }) => closeTask(ctx, sessionId, input),

  record_evaluation: async (ctx, { input }) => {
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
  },

  send_to_matt: async (ctx, { agent, sessionId, input }) => {
    const text = s(input.text, "text", false);
    const ids = [...new Set(list(input.decision_ids).map((id) => id.trim().toUpperCase()))];
    const doc = input.document as { filename?: unknown; content?: unknown } | undefined;
    const document = doc ? { filename: s(doc.filename, "document.filename"), content: s(doc.content, "document.content") } : null;
    if (!text && !ids.length && !document) throw new ToolError("text is required, unless you give decision_ids or a document");
    if (ids.length > MAX_RESENT_CARDS) throw new ToolError(`At most ${MAX_RESENT_CARDS} decision_ids per call; you gave ${ids.length}.`);
    if (document) {
      if (!/^[a-z0-9][a-z0-9-]{0,79}\.md$/.test(document.filename)) {
        throw new ToolError("Nothing sent. document.filename must be lower-case letters, digits and hyphens, ending .md, e.g. weekly-update-2026-11-18.md.");
      }
      if (document.content.length > MAX_DOCUMENT_CHARS) {
        throw new ToolError(`Nothing sent. document.content is ${document.content.length} characters; at most ${MAX_DOCUMENT_CHARS}. Cut slides rather than splitting it.`);
      }
      // The file goes to Matt's Discord DMs (decision 79): refuse before anything is sent.
      if (!ctx.dc || !ctx.ownerDiscordId) throw new ToolError("Nothing sent. Discord isn't set up for Matt (OWNER_DISCORD_ID), so the document can't go out; tell him in a message.");
    }
    const row = await ctx.db.getSession(sessionId);
    if (text && (row?.chat_id || row?.discord_user)) {
      // Matt is already in this conversation and gets her reply: sending as well duplicates it.
      throw new ToolError(
        "You're in a conversation: Matt gets your reply. Put this in your reply instead of using send_to_matt; to give him the decisions' buttons, call it with only decision_ids.",
      );
    }
    // Every id is checked before anything is sent, so a refusal sends nothing (C-4).
    const cards: Decision[] = [];
    const problems: string[] = [];
    for (const id of ids) {
      const d = await ctx.db.getDecision(id);
      if (!d) problems.push(`${id} doesn't exist`);
      else if (d.status !== "open") problems.push(`${id} is ${d.status}, not open`);
      else cards.push(d);
    }
    if (problems.length) throw new ToolError(`Nothing sent. Only open decisions can be re-sent:\n- ${problems.join("\n- ")}`);
    // Recorded, so replying to it in Telegram reaches this session.
    if (text) await sendAgentMessage(ctx, { telegram: ctx.ownerChatId }, { agent, sessionId }, text);
    // A file in Matt's Discord DMs, not a message: a deck doesn't fit a message's limit.
    if (document) {
      const name = agent.charAt(0).toUpperCase() + agent.slice(1);
      await ctx.dc!.dmFile(ctx.ownerDiscordId!, document.filename, document.content, `${name}: ${document.filename}`);
      await ctx.db.audit({ agent, event_type: "discord.document_sent", detail: { filename: document.filename, chars: document.content.length } });
    }
    // The same card and buttons as the original; answering either decides the same decision.
    for (const d of cards) await resendDecisionCard(ctx, d);
    const sent = [text && "the message", document && document.filename].filter(Boolean).join(" and ");
    if (cards.length) return `Sent${sent ? ` ${sent} and` : ""} ${cards.length} card${cards.length === 1 ? "" : "s"}: ${cards.map((d) => d.id).join(", ")}.`;
    return document ? `Sent ${sent}.` : "Sent.";
  },

  vimeo_recordings: async (ctx, { input }) => {
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
  },

  vimeo_transcript: async (ctx, { input }) => {
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
  },

  read_audit: async (ctx, { input }) => readAudit(ctx, input),

  community_stats: async (ctx, { input }) => {
    const day = (v: unknown, field: string) => {
      const t = Date.parse(`${s(v, field)}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v)) || Number.isNaN(t)) throw new ToolError(`${field} must be an ISO date such as 2026-11-02`);
      return new Date(t);
    };
    const today = startOfDay(new Date());
    const asOf = input.as_of ? day(input.as_of, "as_of") : today;
    if (asOf > today || today.getTime() - asOf.getTime() > PR_HISTORY.asOfDays * 86_400_000) {
      throw new ToolError(`as_of must be in the last ${PR_HISTORY.asOfDays} days: the history goes back 24 months from then`);
    }
    const historyFrom = addMonths(asOf, -PR_HISTORY.months);
    const since = input.since ? day(input.since, "since") : undefined;
    if (since && since >= asOf) throw new ToolError("since must be before as_of");
    if (since && since < historyFrom) throw new ToolError(`since must be on or after ${iso(historyFrom).slice(0, 10)}: the history covers 24 months before as_of`);
    // Only the repos in scope: a repo removed from the network keeps its rows until they age out.
    const inScopeRepos = new Set(ctx.network.repos);
    const [all, syncs] = await Promise.all([ctx.db.prHistorySince(iso(historyFrom)), ctx.db.allPrSyncs()]);
    const rows = all.filter((r) => inScopeRepos.has(r.repo));
    const synced = Object.fromEntries(ctx.network.repos.map((r) => [r, syncs.find((x) => x.repo === r)?.synced_from ?? null]));
    const complete = Object.values(synced).every((v) => v !== null);
    return JSON.stringify({
      as_of: iso(asOf),
      repos: ctx.network.repos,
      ...communityStats(rows, asOf, since),
      data: {
        complete,
        // Each repo's last finished refresh; null means its first 24-month read hasn't finished.
        synced,
        prs: rows.length,
        ...(complete ? {} : { warning: "The history is incomplete: some repos haven't finished their first read. Report these figures as provisional." }),
      },
    });
  },

  write_scorecard: async (ctx, { input }) => {
    const period = s(input.period, "period");
    if (!input.scorecard || typeof input.scorecard !== "object") throw new ToolError("scorecard must be an object");
    await ctx.db.putScorecard(period, input.scorecard);
    return `Scorecard ${period} stored.`;
  },
};


/** A change as get_status and read_audit show it. */
function changeView(c: Change) {
  let overlaps: unknown = [];
  try {
    overlaps = c.overlaps ? JSON.parse(c.overlaps) : [];
  } catch {
    // Left as none: the column is only ever written by tickChanges.
  }
  return {
    id: c.id, agent: c.agent, type: c.change_type, state: c.state, pr_url: c.pr_url, measure: c.measure, tool: c.tool,
    verdict: c.verdict, before: c.before, after: c.after, before_cases: c.before_cases, after_cases: c.after_cases,
    overlaps, closed_reason: c.closed_reason,
  };
}

/** D1's timestamp form ("YYYY-MM-DD HH:MM:SS", UTC) for an ISO date or date-time. */
function d1Time(v: string, field: string): string {
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
  if (Number.isNaN(t)) throw new ToolError(`${field} must be an ISO date such as 2026-11-02`);
  return new Date(t).toISOString().slice(0, 19).replace("T", " ");
}

const MAX_AUDIT_DAYS = 92;
const TOKEN_FIELDS = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"] as const;

/** Vera's view of the gateway's records: spend, tokens, models, decisions and denials per agent. */
async function readAudit(ctx: Ctx, input: Input): Promise<string> {
  const since = d1Time(s(input.since, "since"), "since");
  const end = input.until ? d1Time(s(input.until, "until"), "until") : d1Time(new Date().toISOString(), "until");
  if (since >= end) throw new ToolError("since must be before until");
  if (Date.parse(`${end.replace(" ", "T")}Z`) - Date.parse(`${since.replace(" ", "T")}Z`) > MAX_AUDIT_DAYS * 86_400_000) {
    throw new ToolError(`Ask for ${MAX_AUDIT_DAYS} days or fewer at a time`);
  }
  // Open-ended: include rows written this very second, which "now" to the second would cut off.
  const until = input.until ? end : "9999-12-31 23:59:59";
  const [usage, daily, decisions, denials, refusals, toolCalls, changes, blocked, dismissed, gatewayErrors, gatewayErrorCounts, githubWrites, githubWriteCounts] = await Promise.all([
    ctx.db.sessionUsage(since, until),
    ctx.db.dailySpend(since, until),
    ctx.db.decisionsBetween(since, until),
    ctx.db.denials(since, until),
    ctx.db.refusals(since, until),
    ctx.db.toolCalls(since, until),
    ctx.db.changesMeasured(since, until),
    ctx.db.blockedReports(since, until),
    ctx.db.dismissedFindings(since, until),
    ctx.db.gatewayErrors(since, until),
    ctx.db.gatewayErrorCounts(since, until),
    ctx.db.githubWrites(since, until),
    ctx.db.githubWriteCounts(since, until),
  ]);

  type Totals = { sessions: number; cost_cents: number } & Record<(typeof TOKEN_FIELDS)[number], number>;
  const zero = (): Totals => ({ sessions: 0, cost_cents: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 });
  const add = (t: Totals, r: Totals) => {
    for (const k of ["sessions", "cost_cents", ...TOKEN_FIELDS] as const) t[k] += r[k] ?? 0;
  };
  const agents: Record<string, Totals & { by_model: Record<string, Totals>; by_origin: Record<string, Totals>; decisions: Record<string, number> }> = {};
  const agentOf = (name: string) => (agents[name] ??= { ...zero(), by_model: {}, by_origin: {}, decisions: {} });
  for (const r of usage) {
    const a = agentOf(r.agent);
    add(a, r);
    add((a.by_model[r.model] ??= zero()), r);
    add((a.by_origin[r.origin] ??= zero()), r);
  }
  const decided = decisions.filter((d) => d.kind !== "tool.confirm");
  for (const d of decided) {
    const counts = agentOf(d.agent).decisions;
    counts[d.status] = (counts[d.status] ?? 0) + 1;
  }

  return JSON.stringify({
    period: { since, until: end, timezone: "UTC" },
    notes: [
      "Spend is list cost in US cents from Managed Agents session usage, counted on the day each session started.",
      "Sessions from before token and model recording began show 0 tokens and model 'unknown'.",
      "Decision statuses: open, approved (not yet run), executed, failed (approved but the action failed), rejected, lapsed (closed by the gateway because the PR or issue merged, closed or got new commits first, or the agent queued a redraft; neither approved nor rejected). Tool confirmations are excluded.",
      "refusals: custom tool calls the gateway refused for bad input. Cite a refusal or denial as audit:<id>.",
      "Public actions run only through decisions: executed_actions lists them with their ids. Check tool_calls for any external tool that writes.",
      "changes: spec changes the gateway measured in this period, the days before going live against as many after (14, or more when tried again for too little data). overlaps names other changes to the same agent, or to the network, that went live within those windows.",
      "blocked_reports: status reports that listed blockers. Cite one by its id (status:<id>).",
      "dismissed_findings: Mira's review findings dismissed in this period, with the note saying why. Cite one by its id (F-<n>) in the text; it isn't an evidence id.",
      "gateway_errors: failures of the gateway itself (webhooks, schedules, sweeps, GitHub events, follow-ups, Telegram and Discord, tool handlers), oldest first and capped at 200; agent is set only when the failure was in that agent's session. gateway_error_counts gives the exact count per event_type. Cite one as audit:<id>.",
      "github_writes: every write to GitHub (C-7), oldest first and capped at 200: agent, session_id, task_id, the decision that authorised it or 'gateway-internal' with the reason, and args (repo, number, fields changed). flagged is set on a write with neither, such as an agent's own GitHub tool call; check those. github_write_counts gives exact counts per agent and authority. Cite one as audit:<id>.",
    ],
    agents,
    daily_spend: daily,
    rejected: decided.filter((d) => d.status === "rejected").map((d) => ({ id: d.id, agent: d.agent, kind: d.kind, target: d.target, note: d.note })),
    executed_actions: decided
      .filter((d) => d.status === "executed" || d.status === "failed")
      .map((d) => ({ id: d.id, agent: d.agent, kind: d.kind, target: d.target, status: d.status, executed_at: d.executed_at })),
    denials,
    refusals,
    tool_calls: toolCalls,
    changes: changes.map(changeView),
    blocked_reports: blocked,
    dismissed_findings: dismissed,
    gateway_errors: gatewayErrors,
    gateway_error_counts: gatewayErrorCounts,
    github_writes: githubWrites,
    github_write_counts: githubWriteCounts,
  });
}

async function requestAction(ctx: Ctx, agent: string, sessionId: string, input: Input): Promise<string> {
  const kind = s(input.kind, "kind");
  const allowed = ctx.network.agents[agent]?.requestable ?? [];
  if (!allowed.includes(kind)) {
    throw new ToolDenied(`You may not request ${kind}. Allowed: ${allowed.join(", ") || "none"}.`);
  }
  const declared: Risk = toRisk(input.risk);
  if (kind === "github.merge" && agent === "mira" && ctx.network.review_check_required && !(await isReviewCheck(ctx, sessionId))) {
    throw new ToolError("Merge proposals come from the review check. Call request_review_check with your draft review instead.");
  }
  if (kind === "github.review") throw new ToolError("Reviews are posted with submit_review, from a review check.");
  // Rule 5: a member may ask, not instruct. Work a member set going never runs an auto
  // kind, and its cards say whose request it was.
  const member = await sessionMember(ctx, sessionId);
  // Finding 1: the payload is checked now, and the card and the executor both use the checked copy.
  const n = validated(ctx, kind, input.target, input.payload);
  if (ctx.network.action_kinds[kind]?.auto && kind === "github.approve_ci" && declared !== "high" && !member) {
    return autoApproveCi(ctx, agent, sessionId, input, n);
  }
  if (kind === "github.first_response") {
    await checkFirstResponse(ctx, n);
    // Decision 78: posted without Matt once the checks above pass, unless a member set it going or the agent asks.
    if (ctx.network.action_kinds[kind]?.auto && declared !== "high" && !member) {
      const d = await ctx.db.createDecision({ agent, kind, target: n.target, summary: s(input.summary, "summary").slice(0, 200), rationale: s(input.rationale, "rationale"), risk: "low", payload: n.payload, session_id: sessionId });
      const replaced = await replaceOpen(ctx, d);
      const r = await runAuto(ctx, d, "posted automatically after the gateway's checks (decision 78)");
      return `${d.id} ${r.ok ? "done" : "failed"}: ${r.result}${replaced.length ? ` (replaces ${replaced.join(", ")})` : ""}`;
    }
  }
  let rationale = s(input.rationale, "rationale");
  if (member) rationale = `⚠ Prompted by ${member.name} (member) via ${member.platform}.\n\n${rationale}`;
  let risk = maxRisk(declared, actionRisk(ctx, kind, n));
  let reviewId: string | undefined;
  if (kind === "github.merge") {
    // Decision 35: the gateway checks the PR itself, and refuses rather than queue a merge that can't go ahead.
    const ref = prRef(ctx, n.target);
    const sha = typeof n.payload.sha === "string" ? n.payload.sha : "";
    if (sha.length < 7) throw new ToolError("payload.sha is required: the head commit the review check reviewed");
    const f = await prFacts(ctx, ref);
    const review = await ctx.db.latestReview(f.target, f.sha);
    const checks = mergeChecks(f, sha, review);
    if (failed(checks).length) {
      throw new ToolError(`Not queued. The merge can't go ahead yet:\n${checklist(failed(checks))}\nDon't retry in this session; report it.`);
    }
    risk = maxRisk(risk, f.risk === "high" ? "high" : "medium");
    // C-6: the card carries what Matt needs to check the merge from the card alone.
    const findings = review ? await ctx.db.reviewFindings(review.id) : [];
    rationale = `${rationale}\n\n${mergeCard(f, review, findings)}\n\nGateway checks at ${f.sha.slice(0, 7)} (${f.risk} risk: ${f.risk_reasons.join("; ")}):\n${checklist(checks)}`;
    reviewId = review?.id;
  }
  if (kind === "github.rerun_ci" || kind === "github.fix_pr") {
    // Decision 63: only for PRs the network tracks, at the head that failed.
    const ref = prRef(ctx, n.target);
    const sha = String(n.payload.sha ?? "");
    const f = await prFacts(ctx, ref);
    if (f.state !== "OPEN") throw new ToolError(`${f.target} is ${f.state.toLowerCase()}: nothing to do.`);
    if (!(await ctx.db.isTracked(f.target))) throw new ToolError(`${f.target} isn't a PR the network tracks, so it gets no CI fixes. Leave it.`);
    if (!f.sha.startsWith(sha)) throw new ToolError(`The PR has new commits (head is ${f.sha.slice(0, 7)}): its CI runs again. Don't retry for ${sha.slice(0, 7)}.`);
    const earlier = (await ctx.db.decisionsOn(f.target, kind)).find((d) => String(safeJson(d.payload).sha ?? "").startsWith(sha.slice(0, 7)) && !["rejected", "lapsed"].includes(d.status));
    if (earlier) throw new ToolError(`${earlier.id} already asked for ${kind} at ${sha.slice(0, 7)}. Once per head: a second failure counts as real.`);
    if (kind === "github.fix_pr") {
      const fix = await ciFixOf(ctx, sessionId);
      if (!fix || fix.target.toLowerCase() !== f.target.toLowerCase()) throw new ToolError(`Fixes come from a ci_fix task for that PR, and this session's task isn't one for ${f.target}.`);
      // Whole files written for the task's head would undo commits made since.
      if (!f.sha.startsWith(fix.sha)) throw new ToolError(`Your task was for ${fix.sha.slice(0, 7)}, and the PR has moved on to ${f.sha.slice(0, 7)}. Stop: its CI runs again.`);
      const deps = (n.payload.files as { path: string }[]).map((x) => x.path).filter((p) => DEPENDENCY_FILE.test(p));
      if (deps.length && !isDependencyBot((await (await ctx.github()).pull(ref)).user)) {
        throw new ToolError(`Not queued: ${deps.join(", ")} ${deps.length > 1 ? "are dependency files" : "is a dependency file"}, which a fix may change only on a dependency bot's PR.`);
      }
    }
    // Decision 63: a re-run of failed jobs runs without Matt, once per head, on a tracked PR
    // (checked above). The executor re-checks that each run failed at the current head.
    if (kind === "github.rerun_ci" && ctx.network.action_kinds[kind]?.auto && declared !== "high" && !member) {
      const d = await ctx.db.createDecision({ agent, kind, target: n.target, summary: s(input.summary, "summary").slice(0, 200), rationale: s(input.rationale, "rationale"), risk: "low", payload: n.payload, session_id: sessionId });
      const r = await runAuto(ctx, d, "re-run automatically: a tracked PR's failed runs at its current head, once per head (decision 63)");
      return `${d.id} ${r.ok ? "done" : "failed"}: ${r.result}`;
    }
  }
  if (kind === "spec.change") {
    // Rule 5: a member may ask about the network, never set changing it going.
    if (member) throw new ToolDenied(`${member.name} is a member: they can't ask for a change to the network. Answer them, and leave proposals to your weekly evaluation.`);
    const refusal = await proposalGuard(ctx, n.target);
    if (refusal) throw new ToolError(`Not queued. ${refusal}`);
    const gone = await missingEvidence(ctx, n.payload.evidence as string[]);
    const repeat = gone.length ? null : await repeatEvidence(ctx, n.target, n.payload);
    if (repeat) gone.push(repeat);
    if (gone.length) throw new ToolError(`Not queued. Fix the request and call again:\n- ${gone.join("\n- ")}`);
  }
  const d = await ctx.db.createDecision({
    agent,
    kind,
    target: n.target,
    summary: s(input.summary, "summary").slice(0, 200),
    rationale,
    risk,
    payload: n.payload,
    session_id: sessionId,
  });
  if (reviewId) await ctx.db.linkMerge(reviewId, d.id);
  const replaced = REPLACEABLE.includes(kind) ? await replaceOpen(ctx, d) : [];
  await postDecision(ctx, d);
  const also = replaced.length ? ` It replaces ${replaced.join(", ")}, which won't be posted.` : "";
  return `Queued as ${d.id}.${also} Do not wait for it: continue with other work. Check the outcome later with get_decisions.`;
}

/** Kinds where a newer request from the same agent on the same PR or issue is a redraft of the open one. */
const REPLACEABLE = ["github.comment", "github.first_response"];

/**
 * A redraft replaces the open request it redrafts, so approving both can't post the
 * comment twice (pg#1105, pg#1106 and cg#315 got two each). The older one lapses.
 */
async function replaceOpen(ctx: Ctx, d: Decision): Promise<string[]> {
  const older = (await ctx.db.openDecisionsOn(d.target)).filter((o) => o.id !== d.id && o.agent === d.agent && o.kind === d.kind);
  const done: string[] = [];
  for (const o of older) {
    if (!(await ctx.db.lapse(o.id, `replaced by ${d.id}`))) continue;
    await ctx.db.audit({ agent: o.agent, event_type: "gateway.decision_lapsed", detail: { id: o.id, why: `replaced by ${d.id}` } });
    await refreshDecisionCard(ctx, o.id);
    done.push(o.id);
  }
  return done;
}

/**
 * Decision 78: a first response goes only on an open PR or issue the project hasn't
 * answered yet, mentions no one but its author, and says nothing about the network.
 * Fixable problems are refused so the agent redrafts, rather than reaching Matt.
 */
async function checkFirstResponse(ctx: Ctx, n: Normalised) {
  const ref = parseTarget(n.target) as Required<RepoRef>;
  const earlier = [
    ...(await ctx.db.decisionsOn(n.target, "github.first_response")),
    ...(await ctx.db.decisionsOn(n.target, "github.comment")),
  ].find((d) => ["approved", "executed"].includes(d.status));
  if (earlier) throw new ToolError(`Not posted: ${earlier.id} (${earlier.kind}, ${earlier.status}) already answers ${n.target}. A first response is for PRs and issues nobody has answered; leave it.`);
  const { state, author } = await (await ctx.github()).issueState(ref);
  if (state !== "open") throw new ToolError(`Not posted: ${n.target} is ${state}. Leave it.`);
  const problems = publicTextProblems(String(n.payload.text), author);
  if (problems.length) throw new ToolError(`Not posted. Fix the text and call again:\n- payload.text ${problems.join("\n- payload.text ")}`);
}

/** The request as the gateway will run it, or a ToolError listing every problem. */
function validated(ctx: Ctx, kind: string, target: unknown, payload: unknown): Normalised {
  try {
    return validateAction(ctx, kind, s(target, "target"), payload ?? {});
  } catch (e) {
    if (e instanceof ActionInvalid) throw new ToolError(`Not queued. Fix the request and call again:\n- ${e.problems.join("\n- ")}`);
    throw e;
  }
}

/** The member this session acts for, if a member's message set it going. */
async function sessionMember(ctx: Ctx, sessionId: string) {
  return memberOf((await ctx.db.getSession(sessionId))?.started_by);
}

/** Who a session acts for, for the sessions it starts in turn. */
async function sessionStartedBy(ctx: Ctx, sessionId: string): Promise<StartedBy> {
  return (await ctx.db.getSession(sessionId))?.started_by ?? "schedule";
}

function prRef(ctx: Ctx, target: unknown): Required<RepoRef> {
  const ref = parseTarget(s(target, "target"));
  if (!ref?.number) throw new ToolError("target must be a pull request, e.g. accordproject/concerto#123");
  if (!inScope(ctx, ref)) throw new ToolError(`${ref.owner}/${ref.repo} is not in the configured repos`);
  return ref as Required<RepoRef>;
}

/**
 * Mira's labels, one by one, so the gateway's ai/risk:* and ai/decision:* labels
 * survive (decision 41). A PR keeps one kind at most, and only labels the repo
 * already has go on, since GitHub would otherwise create them.
 */
async function labelPr(ctx: Ctx, agent: string, sessionId: string, input: Input): Promise<string> {
  const ref = prRef(ctx, input.target);
  const target = `${ref.owner}/${ref.repo}#${ref.number}`;
  const add = [...new Set(list(input.add))];
  const remove = [...new Set(list(input.remove))];
  if (!add.length && !remove.length) throw new ToolError("give add or remove, or both");
  const theirs = [...add, ...remove].filter((l) => GATEWAY_LABEL.test(l));
  if (theirs.length) throw new ToolError(`${theirs.join(", ")}: ai/risk:* and ai/decision:* are set by the gateway when it posts a review`);
  const kinds = add.filter((l) => l.startsWith("ai/kind:"));
  const bad = kinds.find((l) => !KIND_LABELS.includes(l));
  if (bad) throw new ToolError(`${bad} is not a kind; use one of ${KIND_LABELS.join(", ")}`);
  if (kinds.length > 1) throw new ToolError("a PR has one ai/kind:* label at most");
  const gh = await ctx.github();
  const own = add.filter((l) => !l.startsWith("ai/kind:"));
  if (own.length) {
    const known = new Set(await gh.repoLabels(ref));
    const missing = own.find((l) => !known.has(l));
    if (missing) throw new ToolError(`${missing} is not a label in ${ref.owner}/${ref.repo}; use the repo's own labels`);
  }
  if (ctx.dryRun) return `DRY RUN: would ${[add.length && `add ${add.join(", ")}`, remove.length && `remove ${remove.join(", ")}`].filter(Boolean).join(" and ")} on ${target}`;

  const current = await gh.labels(ref);
  const drop = current.filter((l) => remove.includes(l) || (kinds.length && l.startsWith("ai/kind:") && !kinds.includes(l)));
  const added = add.filter((l) => !current.includes(l));
  // Recorded whether or not it all succeeds: a failure partway still leaves labels changed (C-7).
  let ok = false;
  try {
    for (const l of drop) await gh.removeLabel(ref, l);
    if (added.length) await gh.addLabels(ref, added);
    ok = true;
  } finally {
    if (drop.length || added.length) {
      await recordGithubWrite(ctx, { agent, sessionId, tool: "label_pr", internal: "labels through label_pr", repo: `${ref.owner}/${ref.repo}`, number: ref.number, fields: ["labels"], ok });
    }
  }
  const now = [...current.filter((l) => !drop.includes(l)), ...added];
  await ctx.db.audit({ agent, session_id: sessionId, event_type: "gateway.labelled", detail: { target, added, removed: drop } });
  return `${target} labels: ${now.join(", ") || "none"}`;
}

/** Runs an auto action kind at once, keeping a decision record and an audit entry like any other. */
async function runAuto(ctx: Ctx, d: Decision, why: string) {
  await ctx.db.decide(d.id, "approved", why);
  const r = await executeDecision(ctx, { ...d, status: "approved" }, autoReason(d.kind))
    .then((x) => (x.manual ? { ok: false, result: `${d.kind} has no executor` } : x))
    .catch((e) => ({ ok: false, result: e instanceof Error ? e.message : String(e) }));
  await ctx.db.markExecuted(d.id, r.ok, r.result);
  await ctx.db.audit({ agent: d.agent, session_id: d.session_id ?? undefined, event_type: "gateway.auto_executed", detail: { id: d.id, kind: d.kind, target: d.target, ok: r.ok, result: r.result } });
  return r;
}

/**
 * github.approve_ci without Matt: the gateway checks the PR itself and only goes
 * ahead when nothing in it changes what CI runs or installs. Otherwise it queues
 * the request for Matt as high risk. Either way there is a decision record.
 */
async function autoApproveCi(ctx: Ctx, agent: string, sessionId: string, input: Input, n: Normalised): Promise<string> {
  const { target, payload } = n;
  const ref = prRef(ctx, target);
  const gh = await ctx.github();
  const files = await gh.pullFiles(ref);
  const risky = ciSensitivePaths(files);
  // Finding 4: what limits fork CI is how the repo's workflows run, not only which files changed.
  const unsafe = await ciApprovalRisks(gh, ref);
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
  if (unsafe.length) {
    const d = await ctx.db.createDecision({ ...base, risk: "high", rationale: `${base.rationale}\n\nNot approved automatically: the repo's workflows aren't safe to run for a fork:\n- ${unsafe.join("\n- ")}` });
    await postDecision(ctx, d);
    return `Queued for Matt as ${d.id}: the repo's workflows aren't safe to approve automatically. Continue with other work.`;
  }
  const d = await ctx.db.createDecision({ ...base, risk: "low" });
  const r = await runAuto(ctx, d, "approved automatically: no workflow, build or dependency files changed, and the repo's workflows are safe for forks");
  return `${d.id} ${r.ok ? "done" : "failed"}: ${r.result}`;
}

/**
 * Ada decides a queued decision herself, in three cases only; everything else stays
 * Matt's (decision 52). done: an approved decision carried out or superseded.
 * rejected: an open decision the same agent has since superseded for the same target.
 * approved: an open low-risk github.approve_ci, which must still pass the checks that
 * automatic approval runs.
 */
async function decideAction(ctx: Ctx, sessionId: string, input: Input): Promise<string> {
  const id = s(input.id, "id").toUpperCase();
  const outcome = s(input.outcome, "outcome");
  const note = s(input.note, "note");
  // Rule 5: a member may ask, not instruct, so a member's conversation decides nothing.
  const member = await sessionMember(ctx, sessionId);
  if (member) throw new ToolDenied(`${member.name} is a member: you can't decide anything in a conversation they started.`);
  const d = await ctx.db.getDecision(id);
  if (!d) throw new ToolError(`No decision ${id}`);
  if (d.kind === "tool.confirm") throw new ToolDenied(`${id} is a paused tool call: only Matt decides those.`);
  const why = `Decided by Ada: ${note}`;

  if (outcome === "done") {
    if (d.status !== "approved") throw new ToolDenied(`${id} is ${d.status}: you can mark done only an approved decision waiting to be carried out.`);
    await ctx.db.markExecuted(id, true, why);
  } else if (outcome === "rejected") {
    if (d.status !== "open") throw new ToolDenied(`${id} is ${d.status}, not open.`);
    const later = await ctx.db.laterDecision(d);
    if (!later) throw new ToolDenied(`${id} has no later decision from ${cap(d.agent)} for ${d.target}, so it isn't superseded. Put it to Matt.`);
    if (!(await ctx.db.decide(id, "rejected", `Superseded by ${later.id}. ${why}`))) throw new ToolError(`${id} is no longer open.`);
  } else if (outcome === "approved") {
    if (d.status !== "open") throw new ToolDenied(`${id} is ${d.status}, not open.`);
    if (d.kind !== "github.approve_ci" || d.risk !== "low") {
      throw new ToolDenied(`${id} is ${d.risk}-risk ${d.kind}: you may approve only low-risk github.approve_ci. Put it to Matt.`);
    }
    // The same checks automatic approval runs, against the PR as it is now.
    const ref = prRef(ctx, d.target);
    const gh = await ctx.github();
    const reasons = [...ciSensitivePaths(await gh.pullFiles(ref)).map((f) => `the PR changes ${f}`), ...(await ciApprovalRisks(gh, ref))];
    if (reasons.length) throw new ToolDenied(`Not approved; put ${id} to Matt:\n- ${reasons.join("\n- ")}`);
    if (!(await ctx.db.decide(id, "approved", why))) throw new ToolError(`${id} is no longer open.`);
    const r = await executeDecision(ctx, { ...d, status: "approved" })
      .then((x) => (x.manual ? { ok: false, result: `${d.kind} has no executor` } : x))
      .catch((e) => ({ ok: false, result: e instanceof Error ? e.message : String(e) }));
    await ctx.db.markExecuted(id, r.ok, r.result);
    await ctx.db.audit({ agent: "ada", session_id: sessionId, event_type: "ada.decided", detail: { id, outcome, note, ok: r.ok, result: r.result } });
    await refreshDecisionCard(ctx, id);
    return `${id} approved: ${r.ok ? r.result : `failed: ${r.result}`}. Report it under "Decided for you".`;
  } else {
    throw new ToolError("outcome must be done, rejected or approved");
  }
  await ctx.db.audit({ agent: "ada", session_id: sessionId, event_type: "ada.decided", detail: { id, outcome, note } });
  await refreshDecisionCard(ctx, id);
  return `${id} ${outcome}. Report it under "Decided for you".`;
}

/** Ada closes a task that is done in practice or not needed, once its session has stopped (decision 53). */
async function closeTask(ctx: Ctx, sessionId: string, input: Input): Promise<string> {
  const id = s(input.id, "id").toUpperCase();
  const note = s(input.note, "note");
  const member = await sessionMember(ctx, sessionId);
  if (member) throw new ToolDenied(`${member.name} is a member: you can't close tasks in a conversation they started.`);
  const task = await ctx.db.getTask(id);
  if (!task) throw new ToolError(`No task ${id}`);
  if (!["open", "running", "blocked"].includes(task.status)) throw new ToolError(`${id} is already ${task.status}.`);
  const session = task.session_id ? await ctx.db.getSession(task.session_id) : null;
  if (session && ["running", "rescheduling", "idle:requires_action"].includes(session.status)) {
    throw new ToolDenied(`${id}'s session is still ${session.status === "idle:requires_action" ? "waiting on a decision" : "running"}. Leave it to finish.`);
  }
  await ctx.db.setTask(id, "cancelled");
  await ctx.db.audit({ agent: "ada", session_id: sessionId, event_type: "ada.closed_task", detail: { task: id, of: task.agent, note } });
  // A change nobody is building any more is closed now, not left for the 7-day backstop (decision 55).
  const change = task.kind === "change" ? await ctx.db.changeForTask(id) : null;
  if (change?.state === "building") {
    await ctx.db.updateChange(change.id, { state: "closed", closed_reason: "closed by Ada" });
    await ctx.db.audit({ agent: "ada", session_id: sessionId, event_type: "gateway.change_closed", detail: { change: change.id, reason: "closed by Ada" } });
    return `${id} closed, and with it ${change.id}. Report both under "Decided for you".`;
  }
  return `${id} closed. Report it under "Decided for you".`;
}

/** Session budget and tool-call guidance for each effort level (decision 1B). */
export const EFFORT: Record<string, { cents: number; calls: string }> = {
  small: { cents: 30, calls: "about 10 tool calls" },
  medium: { cents: 100, calls: "about 30 tool calls" },
  large: { cents: 300, calls: "about 80 tool calls" },
};

async function assignTask(ctx: Ctx, parentSessionId: string, input: Input): Promise<string> {
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
  const followsUp = await followUpOf(ctx, s(input.follows_up, "follows_up", false));
  // Mandla only works on approved changes: a follow-up of a change's task, or of the decision
  // that approved it (C-10), takes the change over.
  const earlier = followsUp?.startsWith("T-") ? await ctx.db.getTask(followsUp) : null;
  const change =
    earlier?.kind === "change"
      ? await ctx.db.changeForTask(earlier.id)
      : followsUp?.startsWith("D-") && agent === "mandla"
        ? await ctx.db.changeForDecision(followsUp)
        : null;
  if (agent === "mandla" && !change) throw new ToolError("Mandla only works on approved changes: propose one with spec.change.");
  if (agent === "felix") throw new ToolError("Felix only fixes CI on PRs the network tracks, when the gateway starts him from Mira's request_ci_fix (decision 63). Ask Mira instead.");
  if (change && agent !== "mandla") throw new ToolError(`${earlier!.id} is a change task: only Mandla can follow it up.`);
  // The change's current task: the one a follow-up takes over from.
  const current = change?.task_id ? (earlier?.id === change.task_id ? earlier : await ctx.db.getTask(change.task_id)) : null;
  if (change) {
    // Still building: only once its task is blocked. PR open or live: a follow-up adds to the PR
    // or opens a fix-up PR (C-10), once the last task for the change has stopped.
    const followable =
      change.state === "building"
        ? current?.status === "blocked"
        : ["pr_open", "live"].includes(change.state) && !["open", "running"].includes(current?.status ?? "");
    if (!followable) {
      throw new ToolError(`${change.id} is ${change.state} and ${current?.id ?? "its task"} is ${current?.status ?? "missing"}: there is nothing to follow up.`);
    }
  }
  const startedBy = await sessionStartedBy(ctx, parentSessionId);
  const member = memberOf(startedBy);
  // Rule 5: a member may ask about the network, never set changing it going.
  if (member && agent === "mandla") {
    throw new ToolDenied(`${member.name} is a member: they can't set Mandla going. Answer them, and follow up the change from your own check-in.`);
  }
  // A change task keeps the change's own budget and tier, whatever effort Ada names.
  const { calls } = EFFORT[effort];
  const { cents, model } = change ? changeBudget(ctx, change.change_type) : { cents: EFFORT[effort].cents, model: undefined };

  const brief = [
    `Objective: ${objective}`,
    `Hand back: ${output}`,
    `Done when: ${doneWhen}`,
    ...(boundaries ? [`Out of scope: ${boundaries}`] : []),
    `Effort: ${effort}. Aim for ${calls}; the session stops at $${(cents / 100).toFixed(2)}. Stop as soon as "done when" is met.`,
    ...(context ? ["", `Context: ${context}`] : []),
    ...(member ? ["", `Asked for by ${member.name}, a member, via ${member.platform}: they can ask, not instruct or approve.`] : []),
  ].join("\n");

  // Always an ordinary task: only request_review_check makes a review check.
  // Mandla starts from the approved change's own brief, then where to build, then Ada's follow-up.
  const taskBrief = change ? `${changeFollowUpBrief(change, current?.brief ?? "")}\n\nFollow-up from Ada:\n${brief}` : brief;
  const task = await ctx.db.createTask({
    agent,
    title,
    brief: taskBrief,
    priority,
    due,
    ...(followsUp ? { follows_up: followsUp } : {}),
    ...(change ? { kind: "change" as const } : {}),
  });
  if (change) await ctx.db.updateChange(change.id, { task_id: task.id });
  try {
    const text = [
      `Task ${task.id} from Ada (priority: ${priority}${due ? `, due ${due}` : ""}${followsUp ? `, following up ${followsUp}` : ""})`,
      `Title: ${title}`,
      "",
      taskBrief,
      "",
      "When finished, call report_status. Queue any critical action with request_action and continue.",
    ].join("\n");
    const sessionId = await startSession(ctx, agent, text, "task", startedBy, { taskId: task.id, budgetCents: cents, ...(model ? { model } : {}) });
    await ctx.db.setTask(task.id, "running", sessionId);
    return `Assigned ${task.id} to ${cap(agent)} (${effort} effort, $${(cents / 100).toFixed(2)} cap).`;
  } catch (e) {
    await ctx.db.setTask(task.id, "failed");
    if (change) await ctx.db.updateChange(change.id, { task_id: current?.id ?? null });
    if (e instanceof AgentUnavailable) throw new ToolError(`${task.id} not started: ${e.message}`);
    throw e;
  }
}

/**
 * A change follow-up's brief: the change's own brief (without an earlier follow-up's part)
 * and, once the change has its PR, what submit_change will do with this task's submission (C-10).
 */
function changeFollowUpBrief(change: Change, previous: string): string {
  const own = previous.split("\n\nFollow-up from Ada:\n")[0];
  const branch = `change/${change.id.toLowerCase()}`;
  const where =
    change.state === "pr_open"
      ? `${change.id}'s PR is open: ${change.pr_url}. Build on its branch ${branch}, not main: your edits apply to the files on that branch, and submit_change adds one commit to the PR.`
      : change.state === "live"
        ? `${change.id} is live: its PR ${change.pr_url} is merged. Build on main: submit_change opens a fix-up PR for ${change.id}.`
        : "";
  return where ? `${own}\n\n${where}` : own;
}

/**
 * Checks assign_task's follows_up: an existing task or decision, and no open task
 * already following it up, so the same blocker is never assigned twice (decision 50).
 */
async function followUpOf(ctx: Ctx, raw: string): Promise<string | null> {
  if (!raw) return null;
  const id = raw.toUpperCase();
  if (!/^[TD]-\d+$/.test(id)) throw new ToolError("follows_up must be a task or decision id, e.g. T-12 or D-41");
  const exists = id.startsWith("T-") ? await ctx.db.getTask(id) : await ctx.db.getDecision(id);
  if (!exists) throw new ToolError(`No task or decision ${id}`);
  const open = await ctx.db.openFollowUpOf(id);
  if (open) {
    throw new ToolError(
      `${open.id} (${cap(open.agent)}, ${open.status}) already follows up ${id}. Don't assign it again; if ${open.id} is blocked too, put it to Matt.`,
    );
  }
  return id;
}

/**
 * The PR and head commit a review-check session was started for, or null for any other
 * session. Only request_review_check sets a task's kind; its title is just a label.
 */
async function reviewCheckOf(ctx: Ctx, sessionId: string): Promise<{ target: string; sha: string } | null> {
  const t = await ctx.db.sessionTask(sessionId);
  if (!t || t.agent !== "mira" || t.kind !== "review_check" || !t.review_target || !t.review_sha) return null;
  return { target: t.review_target, sha: t.review_sha };
}

async function isReviewCheck(ctx: Ctx, sessionId: string): Promise<boolean> {
  return !!(await reviewCheckOf(ctx, sessionId));
}

/** The PR and head a ci_fix session was started for (decision 63), or null for any other session. */
async function ciFixOf(ctx: Ctx, sessionId: string): Promise<{ target: string; sha: string } | null> {
  const t = await ctx.db.sessionTask(sessionId);
  if (!t || t.kind !== "ci_fix" || !t.review_target || !t.review_sha) return null;
  return { target: t.review_target, sha: t.review_sha };
}

const findingLine = (f: ReviewFinding) =>
  `- ${f.severity}${f.confidence ? ` (${f.confidence})` : ""} · ${f.area} · ${f.path ? `${f.path}${f.line ? `:${f.line}` : ""}` : "whole PR"}: ${f.summary}`;

const factsLine = (f: PrFacts) =>
  [
    `${f.risk} risk (${f.risk_reasons.join("; ")})`,
    `${f.changed_lines} changed lines in ${f.files.length} files`,
    `author ${f.author ?? "unknown"} (${f.author_association}${f.first_time_contributor ? ", first-time contributor" : ""})`,
    `CI ${f.ci}`,
  ].join("; ");

/**
 * Decision 2A: a draft review goes to a fresh Mira session that has not seen the
 * reasoning behind it. That session verifies each finding against the code, submits
 * only what it confirms (the gateway posts it, decision 36), and is the only place
 * a merge proposal may come from. The gateway picks the tier from the risk band.
 */
/** Mira's review method in the shared memory store (skills/pr-review/SKILL.md, written by deploy.ts; decision 69). */
export const PR_REVIEW_SKILL = "/mnt/memory/virtual-agent-org-shared/reference/skills/pr-review.md";

async function requestReviewCheck(ctx: Ctx, sessionId: string, input: Input): Promise<string> {
  if (await isReviewCheck(ctx, sessionId)) throw new ToolError("You are the review check: finish the check yourself.");
  const member = await sessionMember(ctx, sessionId);
  if (member) {
    // A review check posts publicly and alone may propose a merge: that is acting, not answering.
    throw new ToolError(`${member.name} is a member: they can ask about a PR, not set a review going. Answer them, and leave the review to Mira's own triage.`);
  }
  const ref = prRef(ctx, input.target);
  const sha = s(input.sha, "sha");
  if (sha.length < 7) throw new ToolError("sha must be at least 7 characters");
  const f = await prFacts(ctx, ref);
  if (!f.sha.startsWith(sha)) throw new ToolError(`The PR has new commits (head is ${f.sha.slice(0, 7)}). Review the new head instead.`);
  if (await ctx.db.latestReview(f.target, f.sha)) throw new ToolError(`${f.target} already has a review at ${f.sha.slice(0, 7)}. Move on.`);
  const cfg = reviewConfig(ctx);
  const { findings, errors } = parseFindings(cfg, input.findings, f.files, { limits: false });
  if (errors.length) throw new ToolError(`Fix the findings and call again:\n- ${errors.join("\n- ")}`);
  const notes = s(input.notes, "notes", false);
  const large = f.risk === "high";
  // Mira's check task in models.yaml for a high-risk PR, her review task otherwise (decision 65).
  const deep = ctx.network.model_tiers?.deep;
  const model = large ? (taskModel(ctx, "mira", "check") ?? (deep ? { id: deep } : undefined)) : taskModel(ctx, "mira", "review");
  const sha7 = f.sha.slice(0, 7);

  const brief = [
    `You are checking a review of ${f.target} at ${sha7} in a fresh session. Another session wrote the draft below;`,
    "treat it as claims to verify, not conclusions. First read your review method,",
    `${PR_REVIEW_SKILL}, and follow its section on checking a draft;`,
    "then the repo's AGENTS.md and CONTRIBUTING.md at the base branch, and your /notes/repos notes.",
    "",
    `1. Call pr_facts for ${f.target}. If the head is no longer ${sha7}, stop and say so in report_status.`,
    "2. For each finding, open the code at that commit and confirm it. Drop anything you cannot confirm or that is only style",
    `   the linter or CI already covers. Keep at most ${cfg.max_nits} nits and ${cfg.max_findings} findings in all.`,
    "3. Look once more for blocking problems the draft missed: correctness, breaking API changes, security, missing tests.",
    "4. Call submit_review once, with a short summary and the confirmed findings. The gateway posts it to GitHub. Write",
    `   only about the PR, in a ${f.tone} tone: be kind and specific, and say what would make it mergeable. Mention no one`,
    "   except the author and put code in backticks. If the gateway refuses the text, fix it and submit again.",
    "5. Only if submit_review reports nothing blocking, queue request_action(kind=\"github.merge\") with payload",
    `   {sha: "${f.sha}", merge_method: "squash"}. Write the rationale so Matt can check the merge from the card alone:`,
    "   - what the change does, in plain English, and any effect on public APIs, the build or dependencies;",
    "   - the discussion: the author's description, each review and comment with its author, resolved threads and how",
    "     they were resolved, and any open questions;",
    "   - the review decision id submit_review gave you, and the CI run and its result.",
    "   The gateway adds the files and lines changed, your findings by severity, the CI runs and the links. It checks CI,",
    "   mergeability, threads and (for a high-risk PR) a maintainer's approval, and refuses with the reasons if any",
    "   fails. If it refuses, put the reasons in report_status; don't retry.",
    "",
    `Facts from the gateway: ${factsLine(f)}.`,
    ...(f.path_notes.length ? ["Path rules:", ...f.path_notes.map((n) => `- ${n}`)] : []),
    "",
    `Draft findings (${findings.length}):`,
    ...(findings.length ? findings.map(findingLine) : ["- none"]),
    ...(notes ? ["", `Notes from the draft: ${notes}`] : []),
  ].join("\n");

  const task = await ctx.db.createTask({ agent: "mira", title: `Review check: ${f.target}@${sha7}`, brief, review: { target: f.target, sha: sha7 } });
  try {
    const sid = await startSession(ctx, "mira", brief, "task", await sessionStartedBy(ctx, sessionId), { taskId: task.id, budgetCents: large ? 300 : 150, ...(model ? { model } : {}) });
    await ctx.db.setTask(task.id, "running", sid);
    return `Review check ${task.id} started (${f.risk} risk${large && model ? ", deep tier" : ""}). Do not post this review or propose the merge yourself; move on.`;
  } catch (e) {
    await ctx.db.setTask(task.id, "failed");
    if (e instanceof AgentUnavailable) throw new ToolError(`${task.id} not started: ${e.message}`);
    throw e;
  }
}

/**
 * Decision 36: the review check submits typed findings and the gateway posts them,
 * once it has checked them against the PR and checked the text. Posting is an auto
 * kind (github.review): there is a decision record but no card.
 */
async function submitReview(ctx: Ctx, sessionId: string, input: Input): Promise<string> {
  const check = await reviewCheckOf(ctx, sessionId);
  if (!check) throw new ToolError("Only a review check submits reviews. Call request_review_check with your draft instead.");
  const kind = ctx.network.action_kinds["github.review"];
  if (!kind?.auto || kind.executor !== "github") throw new ToolError("Posting reviews isn't set up (github.review in permissions.yaml). Report it in report_status.");
  const ref = prRef(ctx, input.target);
  const target = `${ref.owner}/${ref.repo}#${ref.number}`;
  if (target.toLowerCase() !== check.target.toLowerCase()) throw new ToolError(`This check is for ${check.target}, not ${target}.`);
  const f = await prFacts(ctx, ref);
  if (!f.sha.startsWith(check.sha)) throw new ToolError(`The PR has new commits (head is ${f.sha.slice(0, 7)}, checked ${check.sha}). Stop and say so in report_status.`);
  if (await ctx.db.latestReview(f.target, f.sha)) throw new ToolError(`A review is already posted at ${f.sha.slice(0, 7)}.`);

  const cfg = reviewConfig(ctx);
  const summary = s(input.summary, "summary");
  if (summary.length > 6000) throw new ToolError("summary is over 6,000 characters; shorten it");
  const { findings, errors } = parseFindings(cfg, input.findings, f.files, { limits: true });
  const problems = [...errors];
  for (const [i, text] of [summary, ...findings.map((x) => x.summary)].entries()) {
    for (const p of publicTextProblems(text, f.author)) problems.push(`${i === 0 ? "summary" : `findings[${i - 1}]`} ${p}`);
  }
  if (problems.length) throw new ToolError(`Not posted. Fix these and submit again:\n- ${problems.join("\n- ")}`);

  const { verdict, body, comments } = renderReview(f.sha, summary, findings);
  const d = await ctx.db.createDecision({
    agent: "mira",
    kind: "github.review",
    target: f.target,
    summary: `Review of ${f.target}: ${verdict.replace("_", " ")}`,
    rationale: `${findings.length} confirmed finding${findings.length === 1 ? "" : "s"} at ${f.sha.slice(0, 7)} (${f.risk} risk).`,
    risk: "low",
    payload: validated(ctx, "github.review", f.target, { sha: f.sha, body, comments, labels: reviewLabels(f.risk, verdict) }).payload,
    session_id: sessionId,
  });
  const r = await runAuto(ctx, d, "posted automatically after the gateway's checks (decision 36)");
  if (!r.ok) return `${d.id} failed: ${r.result}. Report it in report_status; don't propose the merge.`;
  const review = await ctx.db.createReview({
    target: f.target,
    sha: f.sha,
    risk: f.risk,
    verdict,
    decision_id: d.id,
    url: r.result.match(/https:\/\/\S+/)?.[0] ?? null,
    findings: findings.map(({ path, line, severity, area, summary }) => ({ path, line, severity, area, summary })),
  });
  const next =
    verdict === "request_changes"
      ? "It has blocking findings: don't propose the merge."
      : `Nothing blocking. If CI is green and the PR is ready, queue github.merge with payload.sha "${f.sha}".`;
  return `${review.id} (${d.id}) ${r.result}. ${next}`;
}
