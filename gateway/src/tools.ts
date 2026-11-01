// Handlers for the custom tools agents call. The gateway is the enforcement point:
// it checks who may call what before doing anything.

import { AgentUnavailable, postDecision, startSession } from "./agents";
import { cap, type Ctx } from "./context";
import type { Decision } from "./db";
import { ciSensitivePaths, executeDecision, inScope } from "./executors";
import { parseTarget, type RepoRef } from "./github";
import {
  checklist, failed, mergeChecks, parseFindings, prFacts, publicTextProblems, queueFrom, renderReview, reviewConfig, type PrFacts, type ReviewFinding,
} from "./review";
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

    case "submit_review":
      return submitReview(ctx, sessionId, input);

    case "pr_facts": {
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
    }

    case "pr_queue": {
      const repo = s(input.repo, "repo");
      const ref = parseTarget(repo);
      if (!ref || ref.number) throw new ToolError("repo must be owner/name, e.g. accordproject/concerto");
      if (!inScope(ctx, ref)) throw new ToolError(`${repo} is not in the configured repos`);
      const name = `${ref.owner}/${ref.repo}`;
      const gh = await ctx.github();
      const [pulls, reviewed] = await Promise.all([gh.openPulls(ref), ctx.db.reviewedHeads(name)]);
      return JSON.stringify(queueFrom(name, pulls, reviewed));
    }

    case "review_findings": {
      const status = input.status === "all" ? "all" : "open";
      const repo = s(input.repo, "repo", false) || undefined;
      const days = typeof input.days === "number" && input.days > 0 ? Math.floor(input.days) : undefined;
      const [findings, stats] = await Promise.all([ctx.db.listFindings({ open: status === "open", repo, days }), ctx.db.reviewStats(days ?? 90)]);
      return JSON.stringify({ stats, findings });
    }

    case "record_finding_outcome": {
      const id = s(input.id, "id");
      const outcome = s(input.outcome, "outcome");
      if (!["acted", "dismissed"].includes(outcome)) throw new ToolError("outcome must be acted or dismissed");
      if (!(await ctx.db.setFindingOutcome(id, outcome, s(input.note, "note", false) || undefined))) throw new ToolError(`No finding ${id}`);
      return `${id.toUpperCase()}: ${outcome}.`;
    }

    case "record_review_outcome": {
      const target = s(input.target, "target");
      const outcome = s(input.outcome, "outcome");
      if (!["merged", "closed", "reverted", "follow_up"].includes(outcome)) throw new ToolError("outcome must be merged, closed, reverted or follow_up");
      const ref = prRef(ctx, target);
      if (!(await ctx.db.setReviewOutcome(`${ref.owner}/${ref.repo}#${ref.number}`, outcome, s(input.note, "note", false) || undefined))) {
        throw new ToolError(`${target} has no posted review`);
      }
      return `Recorded ${outcome} for ${target}.`;
    }

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
      const row = await ctx.db.getSession(sessionId);
      if (row?.chat_id || row?.discord_user) {
        // Matt is already in this conversation and gets her reply: sending as well duplicates it.
        throw new ToolError("You're in a conversation: Matt gets your reply. Put this in your reply instead of using send_to_matt.");
      }
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
  if (kind === "github.review") throw new ToolError("Reviews are posted with submit_review, from a review check.");
  if (ctx.network.action_kinds[kind]?.auto && kind === "github.approve_ci" && declared !== "high") {
    return autoApproveCi(ctx, agent, sessionId, input);
  }
  let rationale = s(input.rationale, "rationale");
  let risk = maxRisk(declared, floor);
  let reviewId: string | undefined;
  if (kind === "github.merge") {
    // Decision 35: the gateway checks the PR itself, and refuses rather than queue a merge that can't go ahead.
    const ref = prRef(ctx, input.target);
    const payload = (input.payload && typeof input.payload === "object" ? input.payload : {}) as Input;
    const sha = typeof payload.sha === "string" ? payload.sha : "";
    if (sha.length < 7) throw new ToolError("payload.sha is required: the head commit the review check reviewed");
    const f = await prFacts(ctx, ref);
    const review = await ctx.db.latestReview(f.target, f.sha);
    const checks = mergeChecks(f, sha, review);
    if (failed(checks).length) {
      throw new ToolError(`Not queued. The merge can't go ahead yet:\n${checklist(failed(checks))}\nDon't retry in this session; report it.`);
    }
    risk = maxRisk(risk, f.risk === "high" ? "high" : "medium");
    rationale = `${rationale}\n\nGateway checks at ${f.sha.slice(0, 7)} (${f.risk} risk: ${f.risk_reasons.join("; ")}):\n${checklist(checks)}`;
    reviewId = review?.id;
  }
  const d = await ctx.db.createDecision({
    agent,
    kind,
    target: s(input.target, "target"),
    summary: s(input.summary, "summary").slice(0, 200),
    rationale,
    risk,
    payload: input.payload ?? {},
    session_id: sessionId,
  });
  if (reviewId) await ctx.db.linkMerge(reviewId, d.id);
  await postDecision(ctx, d);
  return `Queued as ${d.id}. Do not wait for it: continue with other work. Check the outcome later with get_decisions.`;
}

function prRef(ctx: Ctx, target: unknown): Required<RepoRef> {
  const ref = parseTarget(s(target, "target"));
  if (!ref?.number) throw new ToolError("target must be a pull request, e.g. accordproject/concerto#123");
  if (!inScope(ctx, ref)) throw new ToolError(`${ref.owner}/${ref.repo} is not in the configured repos`);
  return ref as Required<RepoRef>;
}

/** Runs an auto action kind at once, keeping a decision record and an audit entry like any other. */
async function runAuto(ctx: Ctx, d: Decision, why: string) {
  await ctx.db.decide(d.id, "approved", why);
  const r = await executeDecision(ctx, { ...d, status: "approved" })
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
  const r = await runAuto(ctx, d, "approved automatically: no workflow, build or dependency files changed");
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

/** The PR and head commit a review-check session was started for, or null for any other session. */
async function reviewCheckOf(ctx: Ctx, sessionId: string): Promise<{ target: string; sha: string } | null> {
  const t = await ctx.db.sessionTask(sessionId);
  if (!t || t.agent !== "mira" || !t.title.startsWith(CHECK_PREFIX)) return null;
  const [target, sha] = t.title.slice(CHECK_PREFIX.length).split("@");
  return { target, sha };
}

async function isReviewCheck(ctx: Ctx, sessionId: string): Promise<boolean> {
  return !!(await reviewCheckOf(ctx, sessionId));
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
async function requestReviewCheck(ctx: Ctx, sessionId: string, input: Input): Promise<string> {
  if (await isReviewCheck(ctx, sessionId)) throw new ToolError("You are the review check: finish the check yourself.");
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
  const model = large ? ctx.network.model_tiers?.deep : undefined;
  const sha7 = f.sha.slice(0, 7);

  const brief = [
    `You are checking a review of ${f.target} at ${sha7} in a fresh session. Another session wrote the draft below;`,
    "treat it as claims to verify, not conclusions. Read the repo's AGENTS.md and CONTRIBUTING.md at the base branch, and your /notes/repos notes, first.",
    "",
    `1. Call pr_facts for ${f.target}. If the head is no longer ${sha7}, stop and say so in report_status.`,
    "2. For each finding, open the code at that commit and confirm it. Drop anything you cannot confirm or that is only style",
    `   the linter or CI already covers. Keep at most ${cfg.max_nits} nits and ${cfg.max_findings} findings in all.`,
    "3. Look once more for blocking problems the draft missed: correctness, breaking API changes, security, missing tests.",
    "4. Call submit_review once, with a short summary and the confirmed findings. The gateway posts it to GitHub. Write",
    `   only about the PR, in a ${f.tone} tone: be kind and specific, and say what would make it mergeable. Mention no one`,
    "   except the author and put code in backticks. If the gateway refuses the text, fix it and submit again.",
    "5. Only if submit_review reports nothing blocking, queue request_action(kind=\"github.merge\") with payload",
    `   {sha: "${f.sha}", merge_method: "squash"} and a rationale citing your verification. The gateway checks CI,`,
    "   mergeability, threads and (unless the PR is low risk) a maintainer's approval, and refuses with the reasons if",
    "   any fails. If it refuses, put the reasons in report_status; don't retry.",
    "",
    `Facts from the gateway: ${factsLine(f)}.`,
    ...(f.path_notes.length ? ["Path rules:", ...f.path_notes.map((n) => `- ${n}`)] : []),
    "",
    `Draft findings (${findings.length}):`,
    ...(findings.length ? findings.map(findingLine) : ["- none"]),
    ...(notes ? ["", `Notes from the draft: ${notes}`] : []),
  ].join("\n");

  const task = await ctx.db.createTask({ agent: "mira", title: `${CHECK_PREFIX}${f.target}@${sha7}`, brief });
  try {
    const sid = await startSession(ctx, "mira", brief, "task", { taskId: task.id, budgetCents: large ? 300 : 150, ...(model ? { model } : {}) });
    await ctx.db.setTask(task.id, "running", sid);
    return `Review check ${task.id} started (${f.risk} risk${model ? ", deep tier" : ""}). Do not post this review or propose the merge yourself; move on.`;
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
    payload: { sha: f.sha, body, comments },
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
