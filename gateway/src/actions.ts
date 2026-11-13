// One spec per action kind: what a valid request looks like, what the approval card
// shows, and what approval does. The card is built from the same normalised payload the
// executor runs, so what Matt approves is what happens. Critical credentials live here,
// never in agent sandboxes.

import { CHANGE_TYPES, EVIDENCE_ID, MEASURES, OWNER_TYPES, changeRisk, startChange } from "./changes";
import type { ActionKind, Person } from "./config";
import type { Ctx } from "./context";
import type { Decision } from "./db";
import { parseTarget, type RepoRef } from "./github";
import { resolveMentions } from "./people";
import { GATEWAY_LABEL, checklist, failed, mergeChecks, prFacts } from "./review";
import { maxRisk, toRisk, type Risk } from "./risk";
import { isToolName } from "./toolDefs";
import { toSeconds, type Chapter } from "./vimeo";

export interface ExecResult {
  ok: boolean;
  manual?: boolean; // the owner must now do it by hand, then tap "Mark done"
  result: string;
}

export type Payload = Record<string, unknown>;

/** A request with its target and payload checked and normalised. */
export interface Normalised {
  target: string;
  payload: Payload;
}

/** What the card shows: short labelled lines, then long text in full. */
export interface ActionView {
  lines: string[];
  blocks: { title: string; text: string }[];
}

/** Every problem with a request, so the agent can fix them all in one go. */
export class ActionInvalid extends Error {
  constructor(public problems: string[]) {
    super(problems.join("\n"));
  }
}

interface ActionSpec {
  executor: ActionKind["executor"] | "managed";
  validate(ctx: Ctx, target: string, payload: Payload): Normalised;
  describe(target: string, payload: Payload): ActionView;
  execute(ctx: Ctx, d: Decision, n: Normalised): Promise<ExecResult>;
  /** A risk floor that depends on the request itself, above the kind's own. */
  risk?(n: Normalised): Risk;
}

/** The network's own repo: no action kind or tool may touch it, whatever `repos` says. */
export function isNetworkRepo(ctx: Ctx, r: RepoRef): boolean {
  return `${r.owner}/${r.repo}`.toLowerCase() === ctx.network.network_repo?.toLowerCase();
}

export function inScope(ctx: Ctx, r: RepoRef): boolean {
  if (isNetworkRepo(ctx, r)) return false;
  const full = `${r.owner}/${r.repo}`.toLowerCase();
  const allowed = [ctx.network.sandbox_repo, ...ctx.network.repos].filter(Boolean).map((s) => s.toLowerCase());
  return allowed.includes(full);
}

/** The only files github.docs_pr may write: guidance for contributors and review agents. */
export function isGuidanceFile(path: string): boolean {
  return !path.split("/").includes("..") && /(^|\/)(AGENTS|CONTRIBUTING|REVIEWING|CLAUDE)\.md$/.test(path);
}

export function safeJson(s: string | null | undefined): Record<string, unknown> {
  try {
    const v = JSON.parse(s ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

// ---- checking payloads --------------------------------------------------------

/**
 * Reads a payload field by field, collecting problems. Fields not read are unknown
 * and refused, so nothing in a payload can act without appearing on the card.
 */
class Fields {
  problems: string[] = [];
  private seen = new Set<string>();
  constructor(private p: Payload) {}

  private present(k: string) {
    this.seen.add(k);
    const v = this.p[k];
    return v !== undefined && v !== null && !(typeof v === "string" && !v.trim());
  }

  /** Text under `key` or one of its aliases. Two different texts are refused: only one could run. */
  text(key: string, opts: { required?: boolean; max?: number; aliases?: string[] } = {}): string | undefined {
    const keys = [key, ...(opts.aliases ?? [])];
    const set = keys.filter((k) => this.present(k));
    const bad = set.filter((k) => typeof this.p[k] !== "string");
    if (bad.length) {
      this.problems.push(`payload.${bad[0]} must be text`);
      return undefined;
    }
    const values = [...new Set(set.map((k) => (this.p[k] as string).trim()))];
    if (values.length > 1) {
      this.problems.push(`set only one of payload.${set.join(", payload.")}`);
      return undefined;
    }
    const v = values[0];
    if (v === undefined) {
      if (opts.required) this.problems.push(`payload.${key} is required`);
      return undefined;
    }
    if (opts.max && v.length > opts.max) this.problems.push(`payload.${key} is over ${opts.max.toLocaleString("en-GB")} characters`);
    return v;
  }

  bool(key: string): boolean {
    if (!this.present(key)) return false;
    const v = this.p[key];
    if (typeof v !== "boolean") this.problems.push(`payload.${key} must be true or false`);
    return v === true;
  }

  /** A list of names, also accepting a single one. */
  names(key: string, opts: { required?: boolean } = {}): string[] {
    if (!this.present(key)) {
      if (opts.required) this.problems.push(`payload.${key} is required`);
      return [];
    }
    const v = this.p[key];
    const list = typeof v === "string" ? [v] : Array.isArray(v) ? v : null;
    if (!list || list.some((x) => typeof x !== "string")) {
      this.problems.push(`payload.${key} must be a list of names`);
      return [];
    }
    const out = [...new Set((list as string[]).map((x) => x.replace(/^@/, "").trim()).filter(Boolean))];
    if (opts.required && !out.length) this.problems.push(`payload.${key} is required`);
    return out;
  }

  raw(key: string): unknown {
    this.seen.add(key);
    return this.p[key];
  }

  sha(key: string): string | undefined {
    const v = this.text(key, { required: true });
    if (v !== undefined && !/^[0-9a-f]{7,40}$/i.test(v)) this.problems.push(`payload.${key} must be a commit sha of at least 7 characters`);
    return v?.toLowerCase();
  }

  /** Refuses anything not read, then throws if there were problems. */
  done(): void {
    const unknown = Object.keys(this.p).filter((k) => !this.seen.has(k));
    if (unknown.length) this.problems.push(`unknown payload field${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}: remove ${unknown.length > 1 ? "them" : "it"}`);
    if (this.problems.length) throw new ActionInvalid(this.problems);
  }
}

/** Drops undefined values, so a normalised payload is plain JSON. */
const compact = (p: Payload): Payload => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined));

/** The target as "owner/repo" or "owner/repo#N", checked against the configured repos. */
function repoTarget(ctx: Ctx, target: string, problems: string[], number: "required" | "none"): Required<RepoRef> | undefined {
  const ref = parseTarget(target.trim());
  if (!ref) {
    problems.push(`target must be ${number === "required" ? "a pull request or issue, e.g. accordproject/concerto#123" : "a repo, e.g. accordproject/concerto"}`);
    return undefined;
  }
  if (!inScope(ctx, ref)) problems.push(`${ref.owner}/${ref.repo} is not in the configured repos`);
  if (number === "required" && !ref.number) problems.push("target needs a PR or issue number, e.g. accordproject/concerto#123");
  if (number === "none" && ref.number) problems.push("target must be the repo alone, without a PR or issue number");
  return ref as Required<RepoRef>;
}

const refString = (r: RepoRef) => `${r.owner}/${r.repo}${r.number ? `#${r.number}` : ""}`;

function findPerson(ctx: Ctx, who: string): Person | undefined {
  const key = who.toLowerCase();
  return (ctx.network.people ?? []).find((p) => p.github?.toLowerCase() === key || p.name.toLowerCase() === key);
}

// ---- views ------------------------------------------------------------------

const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));
const yesNo = (v: unknown) => (v === true ? "yes" : "no");
const nameList = (v: unknown) => (Array.isArray(v) ? v.map(String).join(", ") : str(v));

/** Shows every field a view didn't cover, so a payload that skipped validation hides nothing. */
function withRest(view: ActionView, payload: Payload, shown: string[]): ActionView {
  const rest = Object.keys(payload).filter((k) => !shown.includes(k) && payload[k] !== undefined);
  if (!rest.length) return view;
  return { ...view, blocks: [...view.blocks, { title: "Other payload fields", text: JSON.stringify(Object.fromEntries(rest.map((k) => [k, payload[k]])), null, 2) }] };
}

/** Text under a field or any of its aliases, for showing payloads stored before they were normalised. */
const pick = (p: Payload, keys: string[]) => keys.map((k) => p[k]).find((v) => typeof v === "string" && v.trim()) as string | undefined;
const pickKey = (p: Payload, keys: string[]) => keys.filter((k) => p[k] !== undefined);

const TEXT_ALIASES = ["text", "body", "message", "comment"];

// ---- GitHub -------------------------------------------------------------------

const MERGE_METHODS = ["squash", "merge", "rebase"];

const githubMerge: ActionSpec = {
  executor: "github",
  validate(ctx, target, payload) {
    const f = new Fields(payload);
    const ref = repoTarget(ctx, target, f.problems, "required");
    const sha = f.sha("sha");
    const method = f.text("merge_method") ?? "squash";
    if (!MERGE_METHODS.includes(method)) f.problems.push(`payload.merge_method must be one of ${MERGE_METHODS.join(", ")}`);
    f.done();
    return { target: refString(ref!), payload: { sha, merge_method: method } };
  },
  describe(target, p) {
    return withRest({ lines: [`Merge: ${target} by ${str(p.merge_method) || "squash"} at ${str(p.sha).slice(0, 7) || "(no sha)"}`], blocks: [] }, p, ["sha", "merge_method"]);
  },
  async execute(ctx, d, { target, payload }) {
    const ref = parseTarget(target) as Required<RepoRef>;
    // Decision 35: the merge checks run again at approval, which may be hours after the proposal.
    const f = await prFacts(ctx, ref);
    const checks = mergeChecks(f, payload.sha as string, await ctx.db.latestReview(f.target, f.sha));
    if (failed(checks).length) return { ok: false, result: `Not merged; the PR changed since the proposal:\n${checklist(failed(checks))}` };
    if (ctx.dryRun) return { ok: true, result: `DRY RUN: would ${d.kind} ${target}` };
    const gh = await ctx.github();
    // GitHub refuses if the head moved after the checks above.
    const r = await gh.merge(ref, payload.merge_method as "merge" | "squash" | "rebase", f.sha);
    if (r.merged) await ctx.db.setReviewOutcome(target, "merged", `merged by the gateway (${d.id})`);
    return { ok: r.merged, result: r.merged ? `Merged as ${r.sha.slice(0, 7)}` : "GitHub did not merge" };
  },
};

const githubClose: ActionSpec = {
  executor: "github",
  validate(ctx, target, payload) {
    const f = new Fields(payload);
    const ref = repoTarget(ctx, target, f.problems, "required");
    const text = f.text("text", { aliases: TEXT_ALIASES.slice(1), max: 65_000 });
    f.done();
    return { target: refString(ref!), payload: compact({ text }) };
  },
  describe(target, p) {
    const text = pick(p, TEXT_ALIASES);
    return withRest(
      { lines: [`Close: ${target}${text ? ", commenting first" : ", with no comment"}`], blocks: text ? [{ title: "Comment", text }] : [] },
      p,
      pickKey(p, TEXT_ALIASES),
    );
  },
  async execute(ctx, d, { target, payload }) {
    if (ctx.dryRun) return { ok: true, result: `DRY RUN: would ${d.kind} ${target}` };
    const ref = parseTarget(target) as Required<RepoRef>;
    const gh = await ctx.github();
    if (payload.text) await gh.comment(ref, payload.text as string);
    await gh.close(ref);
    return { ok: true, result: "Closed" };
  },
};

const githubComment: ActionSpec = {
  executor: "github",
  validate(ctx, target, payload) {
    const f = new Fields(payload);
    const ref = repoTarget(ctx, target, f.problems, "required");
    const text = f.text("text", { required: true, aliases: TEXT_ALIASES.slice(1), max: 65_000 });
    f.done();
    return { target: refString(ref!), payload: { text } };
  },
  describe(target, p) {
    const text = pick(p, TEXT_ALIASES);
    return withRest({ lines: [`Comment on: ${target}, as the project bot`], blocks: text ? [{ title: "Comment", text }] : [] }, p, pickKey(p, TEXT_ALIASES));
  },
  async execute(ctx, d, { target, payload }) {
    if (ctx.dryRun) return { ok: true, result: `DRY RUN: would ${d.kind} ${target}` };
    const c = await (await ctx.github()).comment(parseTarget(target) as Required<RepoRef>, payload.text as string);
    return { ok: true, result: `Commented: ${c.html_url}` };
  },
};

/** How the gateway signs a first response it posts without Matt (decision 78). */
export const FIRST_RESPONSE_FOOTER =
  "<sub>Posted automatically by Mira, an Accord Project agent. A maintainer will follow up; they make the decisions on this.</sub>";
// Text agents are told to sign public drafts with; untrue on a comment nobody approved.
const APPROVED_LABEL = /\n*(?:-{3,}\s*)?\n*(?:<sub>)?\s*Drafted by an Accord Project agent, reviewed by a maintainer\.?\s*(?:<\/sub>)?\s*$/i;
// Signs of an unfinished draft (D-229 posted "Thanks for this, @… placeholder"). "@-free",
// "@free-" and "@name-free" are Mira's own note to avoid mentions leaking into the text.
const DRAFT_MARKER = /\b(placeholder|lorem ipsum|TODO|TBD|FIXME|XXX)\b|<(?:[A-Z][A-Z _-]{2,})>|\[(?:insert|add|your|name|link)\b[^\]]*\]|(?<![\w.])@(?:-free\b|free-|[\w-]+-free\b)/;
const FIRST_RESPONSE_MIN = 80;
const FIRST_RESPONSE_MAX = 4_000;

/** Problems with a first response's text that the gateway can see without GitHub. Code is ignored. */
export function firstResponseProblems(text: string): string[] {
  const problems: string[] = [];
  const prose = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  if (text.length < FIRST_RESPONSE_MIN) problems.push(`payload.text is under ${FIRST_RESPONSE_MIN} characters: say what happens next, not only thanks`);
  const marker = prose.match(DRAFT_MARKER);
  if (marker) problems.push(`payload.text looks unfinished ("${marker[0]}"): finish the draft`);
  if (/reviewed by a maintainer/i.test(prose)) problems.push("payload.text says a maintainer reviewed it, and nobody does: leave the label off, the gateway signs it");
  const end = prose.trimEnd().slice(-1);
  if (end && !/[.!?)\]*_>]/.test(end)) problems.push(`payload.text ends mid-sentence ("…${prose.trimEnd().slice(-30)}"): finish it`);
  return problems;
}

/**
 * Mira's first response to a new PR or issue (decision 78). Auto: posted without a
 * card once the gateway's checks pass (tools.ts), or queued for Matt like a comment
 * when they can't apply. The gateway, not the draft, says who wrote it.
 */
const githubFirstResponse: ActionSpec = {
  executor: "github",
  validate(ctx, target, payload) {
    const f = new Fields(payload);
    const ref = repoTarget(ctx, target, f.problems, "required");
    const text = f.text("text", { required: true, aliases: TEXT_ALIASES.slice(1), max: FIRST_RESPONSE_MAX })?.replace(APPROVED_LABEL, "").trim();
    if (text !== undefined) f.problems.push(...firstResponseProblems(text));
    f.done();
    return { target: refString(ref!), payload: { text } };
  },
  describe(target, p) {
    const text = pick(p, TEXT_ALIASES);
    return withRest({ lines: [`First response on: ${target}, as the project bot`], blocks: text ? [{ title: "Comment", text }] : [] }, p, pickKey(p, TEXT_ALIASES));
  },
  async execute(ctx, d, { target, payload }) {
    if (ctx.dryRun) return { ok: true, result: `DRY RUN: would ${d.kind} ${target}` };
    const c = await (await ctx.github()).comment(parseTarget(target) as Required<RepoRef>, `${payload.text as string}\n\n---\n${FIRST_RESPONSE_FOOTER}`);
    return { ok: true, result: `Commented: ${c.html_url}` };
  },
};

const NOTES_ALIASES = ["body", "text", "notes"];
const COMMITISH_ALIASES = ["commitish", "target_commitish", "target"];

const githubRelease: ActionSpec = {
  executor: "github",
  validate(ctx, target, payload) {
    const f = new Fields(payload);
    const ref = repoTarget(ctx, target, f.problems, "none");
    const tag = f.text("tag", { required: true });
    if (tag && !/^[\w.+\-/]{1,100}$/.test(tag)) f.problems.push("payload.tag must be a tag name such as v1.2.0, with no spaces");
    const name = f.text("name", { max: 200 });
    const body = f.text("body", { aliases: NOTES_ALIASES.slice(1), max: 125_000 });
    const commitish = f.text("commitish", { aliases: COMMITISH_ALIASES.slice(1) });
    const draft = f.bool("draft");
    f.done();
    return { target: refString(ref!), payload: compact({ tag, name, body, commitish, draft }) };
  },
  describe(target, p) {
    const commitish = pick(p, COMMITISH_ALIASES);
    const notes = pick(p, NOTES_ALIASES);
    return withRest(
      {
        lines: [
          `Release: ${target}`,
          `Tag: ${str(p.tag) || "(none)"} · commitish: ${commitish ?? "the default branch"} · draft: ${yesNo(p.draft)}`,
          ...(p.name ? [`Name: ${str(p.name)}`] : []),
        ],
        blocks: notes ? [{ title: "Release notes", text: notes }] : [],
      },
      p,
      ["tag", "name", "draft", ...pickKey(p, [...NOTES_ALIASES, ...COMMITISH_ALIASES])],
    );
  },
  async execute(ctx, d, { target, payload }) {
    if (ctx.dryRun) return { ok: true, result: `DRY RUN: would ${d.kind} ${target}` };
    const r = await (await ctx.github()).release(parseTarget(target)!, {
      tag: payload.tag as string,
      name: payload.name as string | undefined,
      body: (payload.body as string | undefined) ?? "",
      target: payload.commitish as string | undefined,
      draft: payload.draft as boolean,
    });
    return { ok: true, result: `Released: ${r.html_url}` };
  },
};

const githubApproveCi: ActionSpec = {
  executor: "github",
  validate(ctx, target, payload) {
    const f = new Fields(payload);
    const ref = repoTarget(ctx, target, f.problems, "required");
    const sha = f.sha("sha");
    f.done();
    return { target: refString(ref!), payload: { sha } };
  },
  describe(target, p) {
    return withRest({ lines: [`Approve CI: runs waiting for approval on ${target} at ${str(p.sha).slice(0, 7) || "(no sha)"}`], blocks: [] }, p, ["sha"]);
  },
  async execute(ctx, d, { target, payload }) {
    if (ctx.dryRun) return { ok: true, result: `DRY RUN: would ${d.kind} ${target}` };
    const ref = parseTarget(target) as Required<RepoRef>;
    const gh = await ctx.github();
    const pr = await gh.pull(ref);
    const want = payload.sha as string;
    if (!pr.head.sha.startsWith(want)) {
      return { ok: false, result: `PR has new commits since the review (head is ${pr.head.sha.slice(0, 7)}); review again` };
    }
    const runs = await gh.runsAwaitingApproval(ref, pr.head.sha);
    if (!runs.length) return { ok: true, result: `No runs waiting for approval on ${pr.head.sha.slice(0, 7)}` };
    for (const run of runs) await gh.approveRun(ref, run.id);
    return { ok: true, result: `Approved ${runs.length} CI run${runs.length > 1 ? "s" : ""} (${runs.map((r) => r.name).join(", ")}) on ${pr.head.sha.slice(0, 7)}` };
  },
};

// ---- failed CI on tracked PRs (decision 63) ------------------------------------------

/** Dependency manifests and lock files: a fix may change them only on a dependency bot's PR. */
export const DEPENDENCY_FILE = /(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|go\.(mod|sum)|Cargo\.(toml|lock)|pom\.xml|requirements[^/]*\.txt|poetry\.lock|pyproject\.toml|setup\.(py|cfg)|Pipfile(\.lock)?|build\.gradle(\.kts)?|Gemfile(\.lock)?)$/;
/** The bots whose PRs change dependencies, by their REST login. Any other App, release-please say, is not one. */
const DEPENDENCY_BOTS = ["dependabot[bot]", "renovate[bot]"];
export const isDependencyBot = (user: { login: string; type: string } | null | undefined) => user?.type === "Bot" && DEPENDENCY_BOTS.includes(user.login.toLowerCase());
const FIX_LIMITS = { files: 20, chars: 300_000 };
/** The most a fork's fix can be, posted as one comment for its author to apply. */
export const COMMENT_MAX = 65_000;

const githubRerunCi: ActionSpec = {
  executor: "github",
  validate(ctx, target, payload) {
    const f = new Fields(payload);
    const ref = repoTarget(ctx, target, f.problems, "required");
    const sha = f.sha("sha");
    const raw = f.raw("run_ids");
    const runIds = Array.isArray(raw) ? raw : [];
    if (!runIds.length || runIds.length > 20 || runIds.some((x) => !Number.isInteger(x) || (x as number) < 1)) {
      f.problems.push("payload.run_ids must list 1 to 20 workflow run ids, e.g. [1234567890]");
    }
    f.done();
    return { target: refString(ref!), payload: { sha, run_ids: [...new Set(runIds as number[])] } };
  },
  describe(target, p) {
    return withRest(
      { lines: [`Re-run CI: the failed jobs of run${nameList(p.run_ids).includes(",") ? "s" : ""} ${nameList(p.run_ids)} on ${target} at ${str(p.sha).slice(0, 7) || "(no sha)"}`], blocks: [] },
      p,
      ["sha", "run_ids"],
    );
  },
  async execute(ctx, d, { target, payload }) {
    const ref = parseTarget(target) as Required<RepoRef>;
    const gh = await ctx.github();
    const pr = await gh.pull(ref);
    const want = payload.sha as string;
    if (pr.state !== "open") return { ok: false, result: `The PR is ${pr.state}` };
    if (!pr.head.sha.startsWith(want)) return { ok: false, result: `PR has new commits (head is ${pr.head.sha.slice(0, 7)}); its CI runs afresh` };
    const runs = (await gh.runsAt(ref, pr.head.sha)) ?? [];
    const ids = payload.run_ids as number[];
    const notFailed = ids.filter((id) => !runs.some((r) => r.id === id && r.status === "completed" && ["failure", "timed_out", "cancelled"].includes(r.conclusion ?? "")));
    if (notFailed.length) return { ok: false, result: `Not re-run: ${notFailed.join(", ")} ${notFailed.length > 1 ? "aren't failed runs" : "isn't a failed run"} at ${pr.head.sha.slice(0, 7)}` };
    if (ctx.dryRun) return { ok: true, result: `DRY RUN: would ${d.kind} ${target}` };
    for (const id of ids) await gh.rerunFailedJobs(ref, id);
    return { ok: true, result: `Re-running the failed jobs of ${ids.length} run${ids.length > 1 ? "s" : ""} on ${pr.head.sha.slice(0, 7)}` };
  },
};

const githubFixPr: ActionSpec = {
  executor: "github",
  validate(ctx, target, payload) {
    const f = new Fields(payload);
    const ref = repoTarget(ctx, target, f.problems, "required");
    const sha = f.sha("sha");
    const title = f.text("title", { required: true, max: 200 });
    const body = f.text("body", { required: true, max: 20_000 });
    const raw = f.raw("files");
    const files: { path: string; content: string }[] = [];
    if (!Array.isArray(raw) || !raw.length) f.problems.push("payload.files must list the changed files, each {path, content}");
    else {
      raw.forEach((x, i) => {
        const file = (x ?? {}) as Record<string, unknown>;
        const path = typeof file.path === "string" ? file.path.trim() : "";
        if (!path || typeof file.content !== "string") return void f.problems.push(`payload.files[${i}] needs a path and the file's whole content`);
        if (path.startsWith("/") || path.split("/").includes("..")) f.problems.push(`payload.files[${i}]: "${path}" must be a path from the repo root, without ".."`);
        else if (path.startsWith(".github/")) f.problems.push(`payload.files[${i}]: a fix may not change ${path}; anything under .github/ is the maintainers' to change`);
        files.push({ path, content: file.content });
      });
      if (files.length > FIX_LIMITS.files) f.problems.push(`payload.files has ${files.length} files; a fix may change at most ${FIX_LIMITS.files}`);
      const chars = files.reduce((n, x) => n + x.content.length, 0);
      if (chars > FIX_LIMITS.chars) f.problems.push(`payload.files totals ${chars.toLocaleString("en-GB")} characters; at most ${FIX_LIMITS.chars.toLocaleString("en-GB")}`);
      if (new Set(files.map((x) => x.path)).size !== files.length) f.problems.push("payload.files names a file twice");
    }
    f.done();
    return { target: refString(ref!), payload: { sha, title, body, files } };
  },
  describe(target, p) {
    const files = Array.isArray(p.files) ? (p.files as { path: string; content: string }[]) : [];
    return withRest(
      {
        lines: [
          `Fix CI: on ${target} at ${str(p.sha).slice(0, 7) || "(no sha)"}, ${files.length} file${files.length === 1 ? "" : "s"}: ${files.map((x) => x.path).join(", ")}`,
          "If the PR's branch is in the repo, opens a PR into that branch; for a fork, posts the files as a comment for the author to apply",
          ...(p.title ? [`Title: ${str(p.title)}`] : []),
        ],
        blocks: [
          ...(p.body ? [{ title: "What broke and how it was tested", text: str(p.body) }] : []),
          ...files.map((x) => ({ title: `${x.path}, whole file`, text: x.content || "(empty)" })),
        ],
      },
      p,
      ["sha", "title", "body", "files"],
    );
  },
  async execute(ctx, d, { target, payload }) {
    const ref = parseTarget(target) as Required<RepoRef>;
    const gh = await ctx.github();
    const pr = await gh.pull(ref);
    const want = payload.sha as string;
    if (pr.state !== "open") return { ok: false, result: `The PR is ${pr.state}` };
    if (!pr.head.sha.startsWith(want)) return { ok: false, result: `PR has new commits (head is ${pr.head.sha.slice(0, 7)}); the fix was for ${want.slice(0, 7)}` };
    if (ctx.dryRun) return { ok: true, result: `DRY RUN: would ${d.kind} ${target}` };
    const files = payload.files as { path: string; content: string }[];
    const note = `\n\n---\nDrafted by an Accord Project agent (${d.id}) and approved before it was posted; review it like any other change.`;
    if (pr.head.repo?.full_name?.toLowerCase() === pr.base.repo.full_name.toLowerCase()) {
      const made = await gh.proposeFix(ref, {
        branch: `agents/felix-${d.id.toLowerCase()}`,
        headSha: pr.head.sha,
        headBranch: pr.head.ref,
        files,
        message: payload.title as string,
        title: payload.title as string,
        body: `Fixes CI on #${ref.number}.\n\n${payload.body as string}${note}`,
      });
      return { ok: true, result: `Opened ${made.html_url} into ${pr.head.ref}` };
    }
    const comment = fixComment(payload.title as string, payload.body as string, files) + note;
    if (comment.length > COMMENT_MAX) return { ok: false, result: `Too large to post as a comment (${comment.length.toLocaleString("en-GB")} characters); the PR is from a fork, so the gateway can't push the fix` };
    const c = await gh.comment(ref, comment);
    return { ok: true, result: `Posted the fix for the author to apply: ${c.html_url}` };
  },
};

/** A fork's fix as one comment: what broke, then each file whole, fenced so it copies cleanly. */
export function fixComment(title: string, body: string, files: { path: string; content: string }[]): string {
  const fence = (t: string) => "`".repeat(Math.max(3, ...[...t.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return [
    `**${title}**`,
    "",
    body,
    "",
    `The fix changes ${files.length} file${files.length === 1 ? "" : "s"}. Replace each with the content below:`,
    ...files.flatMap((x) => ["", `\`${x.path}\``, fence(x.content), x.content, fence(x.content)]),
  ].join("\n");
}

type InlineComment = { path: string; line: number; body: string };

const githubReview: ActionSpec = {
  executor: "github",
  validate(ctx, target, payload) {
    // Built by submit_review (decision 36), never by an agent; checked all the same.
    const f = new Fields(payload);
    const ref = repoTarget(ctx, target, f.problems, "required");
    const sha = f.sha("sha");
    const body = f.text("body", { required: true, max: 65_000 });
    const rawComments = f.raw("comments") ?? [];
    const comments: InlineComment[] = [];
    if (!Array.isArray(rawComments)) f.problems.push("payload.comments must be a list");
    else
      rawComments.forEach((c, i) => {
        const x = (c ?? {}) as Record<string, unknown>;
        if (typeof x.path !== "string" || !x.path || !Number.isInteger(x.line) || (x.line as number) < 1 || typeof x.body !== "string" || !x.body) {
          f.problems.push(`payload.comments[${i}] needs a path, a positive line and a body`);
        } else comments.push({ path: x.path, line: x.line as number, body: x.body });
      });
    const labels = f.names("labels");
    const bad = labels.filter((l) => !GATEWAY_LABEL.test(l));
    if (bad.length) f.problems.push(`payload.labels may only be the gateway's ai/risk and ai/decision labels, not ${bad.join(", ")}`);
    f.done();
    return { target: refString(ref!), payload: { sha, body, comments, labels } };
  },
  describe(target, p) {
    const comments = Array.isArray(p.comments) ? (p.comments as InlineComment[]) : [];
    return withRest(
      {
        lines: [
          `Review: posts a comment-only review on ${target} at ${str(p.sha).slice(0, 7) || "(no sha)"}`,
          ...(Array.isArray(p.labels) && p.labels.length ? [`Labels: ${nameList(p.labels)}`] : []),
        ],
        blocks: [
          ...(typeof p.body === "string" ? [{ title: "Review", text: p.body }] : []),
          ...(comments.length ? [{ title: `Inline comments (${comments.length})`, text: comments.map((c) => `${c.path}:${c.line}\n${c.body}`).join("\n\n") }] : []),
        ],
      },
      p,
      ["sha", "body", "comments", "labels"],
    );
  },
  async execute(ctx, d, { target, payload }) {
    if (ctx.dryRun) return { ok: true, result: `DRY RUN: would ${d.kind} ${target}` };
    const ref = parseTarget(target) as Required<RepoRef>;
    const gh = await ctx.github();
    const review = { commit_id: payload.sha as string, body: payload.body as string, comments: payload.comments as InlineComment[] };
    let posted: string;
    try {
      const r = await gh.createReview(ref, review);
      posted = `Posted review: ${r.html_url}`;
    } catch (e) {
      // A line outside the diff makes GitHub refuse the whole review: post the findings in the body instead.
      if (!review.comments.length || !String(e).includes(": 422")) throw e;
      const moved = review.comments.map((c) => `- \`${c.path}:${c.line}\` ${c.body.replace(/\n\n/, ": ")}`).join("\n");
      const r = await gh.createReview(ref, { ...review, body: review.body.replace(/\n---\n/, `\n${moved}\n\n---\n`), comments: [] });
      posted = `Posted review: ${r.html_url} (findings in the summary; GitHub refused the inline comments)`;
    }
    const labels = payload.labels as string[];
    if (!labels.length) return { ok: true, result: posted };
    // The review is posted either way; a label GitHub refuses is reported, not fatal.
    try {
      for (const old of (await gh.labels(ref)).filter((l) => GATEWAY_LABEL.test(l) && !labels.includes(l))) await gh.removeLabel(ref, old);
      await gh.addLabels(ref, labels);
      return { ok: true, result: `${posted} and labelled it ${labels.join(", ")}` };
    } catch (e) {
      return { ok: true, result: `${posted} but couldn't label it (${e instanceof Error ? e.message : String(e)})` };
    }
  },
};

const githubDocsPr: ActionSpec = {
  executor: "github",
  validate(ctx, target, payload) {
    const f = new Fields(payload);
    const ref = repoTarget(ctx, target, f.problems, "none");
    const path = f.text("path", { required: true })?.replace(/^\/+/, "");
    if (path && !isGuidanceFile(path)) f.problems.push(`docs_pr only writes AGENTS.md, CONTRIBUTING.md, REVIEWING.md or CLAUDE.md, not "${path}"`);
    const content = f.text("content", { required: true, max: 200_000 });
    const title = f.text("title", { max: 200 }) ?? (path ? `Update ${path} with review lessons` : undefined);
    const body = f.text("body", { max: 60_000 });
    f.done();
    return { target: refString(ref!), payload: compact({ path, content: content!.endsWith("\n") ? content : `${content}\n`, title, body }) };
  },
  describe(target, p) {
    const content = str(p.content);
    return withRest(
      {
        lines: [`Opens a PR on ${target} replacing ${str(p.path) || "(no path)"}`, ...(p.title ? [`PR title: ${str(p.title)}`] : [])],
        blocks: [
          ...(p.body ? [{ title: "PR description", text: str(p.body) }] : []),
          { title: `New ${str(p.path) || "file"}, whole file (${content.length.toLocaleString("en-GB")} characters)`, text: content || "(empty)" },
        ],
      },
      p,
      ["path", "content", "title", "body"],
    );
  },
  async execute(ctx, d, { target, payload }) {
    if (ctx.dryRun) return { ok: true, result: `DRY RUN: would ${d.kind} ${target}` };
    const pr = await (await ctx.github()).proposeFile(parseTarget(target)!, {
      path: payload.path as string,
      content: payload.content as string,
      branch: `agents/${d.agent}-${d.id.toLowerCase()}`,
      title: payload.title as string,
      body: `${(payload.body as string | undefined) || d.rationale}\n\n---\nDrafted by an Accord Project agent (${d.id}); needs a maintainer's review like any other PR.`,
    });
    return { ok: true, result: `Opened ${pr.html_url}` };
  },
};

// ---- Vimeo --------------------------------------------------------------------

const vimeoPublish: ActionSpec = {
  executor: "vimeo",
  validate(_ctx, target, payload) {
    const f = new Fields(payload);
    const rawId = f.raw("video_id");
    const id = typeof rawId === "number" ? String(rawId) : typeof rawId === "string" ? rawId.trim() : "";
    if (!/^\d+$/.test(id)) f.problems.push("payload.video_id is required: the video's number");
    // The target is the link Matt may open; it must be the video that changes.
    const linked = target.match(/vimeo\.com\/(?:video\/)?(\d+)/)?.[1];
    if (linked && id && linked !== id) f.problems.push(`target links to video ${linked} but payload.video_id is ${id}`);
    const name = f.text("name", { required: true, max: 128 });
    const description = f.text("description", { required: true, max: 5000 });
    const make_public = f.bool("make_public");
    const rawChapters = f.raw("chapters") ?? [];
    const chapters: Chapter[] = [];
    if (!Array.isArray(rawChapters)) f.problems.push("payload.chapters must be a list");
    else
      rawChapters.forEach((c, i) => {
        const x = (c ?? {}) as Record<string, unknown>;
        let ok = typeof x.title === "string" && !!x.title.trim() && (typeof x.start === "string" || typeof x.start === "number");
        if (ok) {
          try {
            toSeconds(x.start as string | number);
          } catch {
            ok = false;
          }
        }
        if (!ok) f.problems.push(`payload.chapters[${i}] needs a title and a start such as "4:30"`);
        else chapters.push({ title: (x.title as string).trim().slice(0, 100), start: x.start as string | number });
      });
    f.done();
    return { target: `https://vimeo.com/${id}`, payload: { video_id: id, name, description, make_public, ...(chapters.length ? { chapters } : {}) } };
  },
  describe(_target, p) {
    const chapters = Array.isArray(p.chapters) ? (p.chapters as Chapter[]) : [];
    return withRest(
      {
        lines: [
          `Video: ${str(p.video_id) || "(none)"} (https://vimeo.com/${str(p.video_id)})`,
          `Title: ${str(p.name)}`,
          p.make_public === true ? "⚠ Makes the video PUBLIC on Vimeo" : "Privacy: left as it is",
        ],
        blocks: [
          { title: "Description", text: str(p.description) || "(none)" },
          ...(chapters.length ? [{ title: `Chapters (${chapters.length})`, text: chapters.map((c) => `${c.start}  ${c.title}`).join("\n") }] : []),
        ],
      },
      p,
      ["video_id", "name", "description", "make_public", "chapters"],
    );
  },
  /**
   * Chapters first (best effort), then title and description, and only then, if
   * asked, make the video public. A failure before the last step leaves the video as
   * private as it was.
   */
  async execute(ctx, _d, { payload: p }) {
    const id = p.video_id as string;
    const chapters = (p.chapters as Chapter[] | undefined) ?? [];
    const vimeo = ctx.vimeo();
    const video = await vimeo.ownVideo(id); // refuses videos the account doesn't own
    if (ctx.dryRun) {
      return { ok: true, result: `DRY RUN: would update "${video.name}"${chapters.length ? ` with ${chapters.length} chapters` : ""}${p.make_public ? " and make it public" : ""}` };
    }
    const notes: string[] = [];
    let added = 0;
    for (const c of chapters) {
      try {
        const secs = toSeconds(c.start);
        if (secs < 1 || (video.duration && secs >= video.duration)) throw new Error(`time ${c.start} is outside the video`);
        await vimeo.addChapter(id, c.title, secs);
        added++;
      } catch (e) {
        notes.push(`chapter "${c.title}" skipped: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await vimeo.edit(id, { name: p.name as string, description: p.description as string });
    if (p.make_public) await vimeo.edit(id, { privacy: { view: "anybody" } });

    const done = [`Updated title and description`, chapters.length ? `${added} of ${chapters.length} chapters added` : "", p.make_public ? "now PUBLIC" : `still ${video.privacy}`]
      .filter(Boolean)
      .join("; ");
    return { ok: true, result: `${done}: ${video.link}${notes.length ? `\nNotes: ${notes.slice(0, 3).join("; ")}` : ""}` };
  },
};

// ---- Discord ------------------------------------------------------------------

const POST_ALIASES = ["text", "post", "message", "content", "body"];

const discordAnnounce: ActionSpec = {
  executor: "discord",
  validate(_ctx, _target, payload) {
    const f = new Fields(payload);
    const text = f.text("text", { required: true, aliases: POST_ALIASES.slice(1), max: 20_000 });
    f.done();
    return { target: "discord:#announcements", payload: { text } };
  },
  describe(_target, p) {
    const text = pick(p, POST_ALIASES);
    return withRest({ lines: ["Posts to: the announcements channel, labelled as agent-drafted, pinging no one"], blocks: text ? [{ title: "Post", text }] : [] }, p, pickKey(p, POST_ALIASES));
  },
  async execute(ctx, _d, { payload }) {
    const text = payload.text as string;
    if (!ctx.discord.configured) {
      return { ok: true, manual: true, result: "No announcements channel is set in config/discord.yaml. Copy the content above, post it, then tap Mark done." };
    }
    if (ctx.dryRun) return { ok: true, result: `DRY RUN: would post ${text.length} characters to Discord` };
    const n = await ctx.discord.post(text);
    return { ok: true, result: `Posted to Discord${n > 1 ? ` (${n} messages)` : ""}` };
  },
};

const discordOps: ActionSpec = {
  executor: "discord_ops",
  validate(ctx, _target, payload) {
    const f = new Fields(payload);
    const text = f.text("text", { required: true, aliases: POST_ALIASES.slice(1), max: 20_000 });
    const mention: string[] = [];
    for (const who of f.names("mention")) {
      const p = findPerson(ctx, who);
      if (!p?.discord) f.problems.push(`Can't ping ${who}: not in people.yaml with a Discord id`);
      else if (!mention.includes(p.name)) mention.push(p.name);
    }
    f.done();
    return { target: "discord:#agent-ops", payload: { text, mention } };
  },
  describe(_target, p) {
    const text = pick(p, POST_ALIASES);
    const pings = Array.isArray(p.mention) && p.mention.length ? nameList(p.mention) : "";
    return withRest(
      { lines: ["Posts to: #agent-ops", `Pings: ${pings || "no one"}`], blocks: text ? [{ title: "Post", text }] : [] },
      p,
      ["mention", ...pickKey(p, POST_ALIASES)],
    );
  },
  async execute(ctx, _d, { payload }) {
    const m = resolveMentions(ctx, payload.mention);
    if (!ctx.discordOps.configured) {
      return { ok: true, manual: true, result: "No agent_ops channel is set in config/discord.yaml. Copy the content above, post it, then tap Mark done." };
    }
    const who = m.names.length ? ` pinging ${m.names.join(", ")}` : "";
    if (ctx.dryRun) return { ok: true, result: `DRY RUN: would post to #agent-ops${who}` };
    await ctx.discordOps.post(payload.text as string, m.ids);
    return { ok: true, result: `Posted to #agent-ops${who}` };
  },
};

const messagePerson: ActionSpec = {
  executor: "discord_dm",
  validate(ctx, _target, payload) {
    // A message to named people from people.yaml, sent as a Discord DM from the bot.
    const f = new Fields(payload);
    const to: string[] = [];
    for (const who of f.names("to", { required: true })) {
      const p = findPerson(ctx, who);
      if (!p) f.problems.push(`${who} is not in people.yaml: name people by GitHub login or name`);
      else if (!to.includes(p.name)) to.push(p.name);
    }
    const text = f.text("text", { required: true, aliases: ["message", "body"], max: 20_000 });
    f.done();
    // The target becomes the recipients, so lists of decisions name who it goes to.
    return { target: to.join(", "), payload: { to, text } };
  },
  describe(_target, p) {
    const text = pick(p, ["text", "message", "body"]);
    return withRest(
      { lines: [`To: ${nameList(p.to) || "(no one)"}, as a Discord DM from the bot (by hand for anyone without a Discord id)`], blocks: text ? [{ title: "Message", text }] : [] },
      p,
      ["to", ...pickKey(p, ["text", "message", "body"])],
    );
  },
  async execute(ctx, _d, { payload }) {
    const text = payload.text as string;
    const m = resolveMentions(ctx, payload.to);
    if (m.missing.length || !ctx.dc) {
      const why = !ctx.dc ? "The Discord bot isn't set up" : `Can't DM ${m.missing.join(", ")}: no Discord id in people.yaml`;
      return { ok: true, manual: true, result: `${why}. Copy the content above, send it, then tap Mark done.` };
    }
    if (ctx.dryRun) return { ok: true, result: `DRY RUN: would DM ${m.names.join(", ")}` };
    for (const id of m.ids) await ctx.dc.dm(id, { content: text });
    return { ok: true, result: `Sent a Discord DM to ${m.names.join(", ")}` };
  },
};

// ---- the self-improvement loop ------------------------------------------------

/** A proposal to change an agent (or the network): checked here, built by Mandla once approved. */
const specChange: ActionSpec = {
  executor: "task",
  validate(ctx, target, payload) {
    const f = new Fields(payload);
    const t = target.trim().toLowerCase();
    if (t !== "network" && !ctx.network.agents[t]) f.problems.push("target must be an agent, e.g. mira, or network");
    const type = f.text("change_type", { required: true });
    if (type !== undefined && !CHANGE_TYPES.includes(type)) f.problems.push(`payload.change_type must be one of ${CHANGE_TYPES.join(", ")}`);
    const problem = f.text("problem", { required: true, max: 2_000 });
    const change = f.text("change", { required: true, max: 20_000 });
    const evidence = evidenceIds(f);
    const measure = f.text("measure", { required: true });
    if (measure !== undefined && !MEASURES.includes(measure)) f.problems.push(`payload.measure must be one of ${MEASURES.join(", ")}`);
    const tool = f.text("tool");
    if (measure === "tool_refusals" && tool === undefined) f.problems.push("payload.tool is required for tool_refusals");
    if (tool !== undefined && measure !== undefined && measure !== "tool_refusals") f.problems.push("payload.tool is only for tool_refusals");
    else if (tool !== undefined && !isToolName(tool)) f.problems.push(`${tool} is not a gateway tool`);
    f.done();
    return { target: t, payload: compact({ change_type: type, problem, change, evidence, measure, tool }) };
  },
  describe(target, p) {
    const type = str(p.change_type);
    const lines = [
      `Spec change: ${target}, ${type}${OWNER_TYPES.includes(type) ? " (owner-only type)" : ""}`,
      `Evidence: ${nameList(p.evidence)}`,
      `Measure: ${str(p.measure)}${p.tool ? ` (${str(p.tool)})` : ""}`,
      "Approving starts a task for Mandla that opens a PR on the network repo; nothing merges without your review.",
    ];
    const blocks = [
      { title: "Problem", text: str(p.problem) },
      { title: "Change", text: str(p.change) },
    ];
    return withRest({ lines, blocks }, p, ["change_type", "problem", "change", "evidence", "measure", "tool"]);
  },
  execute: (ctx, d, n) => startChange(ctx, d, n),
  risk: (n) => changeRisk(n.target, str(n.payload.change_type)),
};

/** The evidence: 1 to 30 ids of decisions, tasks, audit rows or status reports. */
function evidenceIds(f: Fields): string[] | undefined {
  const v = f.raw("evidence");
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    f.problems.push("payload.evidence must be a list of ids, e.g. [\"D-12\", \"audit:301\"]");
    return undefined;
  }
  const ids = [...new Set((v as string[]).map((x) => x.trim()))];
  if (ids.length < 1 || ids.length > 30) f.problems.push("payload.evidence needs 1 to 30 ids");
  const bad = ids.filter((x) => !EVIDENCE_ID.test(x));
  if (bad.length) f.problems.push(`payload.evidence: ${bad.map((x) => `"${x}"`).join(", ")} ${bad.length > 1 ? "are not ids" : "is not an id"} such as D-12, T-4, audit:301 or status:17`);
  return ids;
}

// ---- manual and tool confirmations ----------------------------------------------

const label = (k: string) => k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, " ");

/**
 * Kinds Matt carries out by hand: the payload is free text for him to copy. Any field
 * may be used, but only text or lists of text, and all of it is on the card.
 */
const manual: ActionSpec = {
  executor: "manual",
  validate(_ctx, target, payload) {
    const f = new Fields(payload);
    const out: Payload = {};
    for (const k of Object.keys(payload)) {
      const v = f.raw(k);
      if (v === undefined || v === null) continue;
      if (typeof v === "string") out[k] = v.trim();
      else if (Array.isArray(v) && v.every((x) => typeof x === "string")) out[k] = v;
      else f.problems.push(`payload.${k} must be text or a list of text`);
    }
    if (JSON.stringify(out).length > 60_000) f.problems.push("payload is over 60,000 characters");
    f.done();
    return { target: target.trim(), payload: out };
  },
  describe(target, p) {
    const lines = [`By hand: ${target || "(no target)"}`];
    const blocks: ActionView["blocks"] = [];
    for (const [k, v] of Object.entries(p)) {
      const text = Array.isArray(v) ? v.map(String).join(", ") : str(v);
      if (text.length > 80 || text.includes("\n")) blocks.push({ title: label(k), text });
      else lines.push(`${label(k)}: ${text}`);
    }
    return { lines, blocks };
  },
  async execute(_ctx, _d, { payload }) {
    const hasText = Object.values(payload).some((v) => (typeof v === "string" ? v : "").trim());
    return { ok: true, manual: true, result: hasText ? "Approved. Copy the content above, do it, then tap Mark done." : "Approved. Do it, then tap Mark done." };
  },
};

/** An MCP or built-in tool call paused under always_ask. */
const toolConfirm: ActionSpec = {
  executor: "managed",
  validate(_ctx, target, payload) {
    const f = new Fields(payload);
    const input = f.raw("input");
    // Set only on an MCP call's confirmation, so its approval can be recorded as a GitHub write (C-7).
    const hasServer = "mcp_server" in payload;
    const server = f.raw("mcp_server");
    f.done();
    return { target, payload: { input: input ?? {}, ...(hasServer ? { mcp_server: typeof server === "string" ? server : null } : {}) } };
  },
  describe(target, p) {
    const lines = [`Tool: ${target}`, ...(typeof p.mcp_server === "string" ? [`MCP server: ${p.mcp_server}`] : [])];
    return withRest({ lines, blocks: [{ title: "Input", text: JSON.stringify(p.input ?? {}, null, 2) }] }, p, ["input", "mcp_server"]);
  },
  async execute(ctx, d) {
    if (!d.session_id || !d.tool_use_id) return { ok: false, result: "Missing session or tool use id" };
    await ctx.managed.sendToolConfirmation(d.session_id, d.tool_use_id, true);
    return { ok: true, result: "Tool call allowed" };
  },
};

export const ACTIONS: Record<string, ActionSpec> = {
  "github.merge": githubMerge,
  "github.close": githubClose,
  "github.comment": githubComment,
  "github.first_response": githubFirstResponse,
  "github.release": githubRelease,
  "github.approve_ci": githubApproveCi,
  "github.rerun_ci": githubRerunCi,
  "github.fix_pr": githubFixPr,
  "github.review": githubReview,
  "github.docs_pr": githubDocsPr,
  "vimeo.publish": vimeoPublish,
  "wordpress.publish": manual,
  "linkedin.post": manual,
  "discord.announce": discordAnnounce,
  "discord.ops": discordOps,
  "message.person": messagePerson,
  "email.send": manual,
  "spec.change": specChange,
  other: manual,
  "tool.confirm": toolConfirm,
};

/**
 * The spec that runs a kind under the current config. A kind set to the manual
 * executor (or a kind the config doesn't list) is carried out by hand. Otherwise the
 * kind's spec must exist and agree with permissions.yaml about the executor.
 */
function specFor(ctx: Ctx, kind: string): ActionSpec | { error: string } {
  if (kind === "tool.confirm") return toolConfirm;
  const cfg = ctx.network.action_kinds[kind];
  if (!cfg || cfg.executor === "manual") return manual;
  const spec = ACTIONS[kind];
  if (!spec || spec.executor !== cfg.executor) return { error: `No executor for ${kind}` };
  return spec;
}

/**
 * Checks a request when it is made: the target and payload as they will be stored and
 * run. Throws ActionInvalid listing every problem.
 */
export function validateAction(ctx: Ctx, kind: string, target: string, payload: unknown): Normalised {
  if (kind !== "tool.confirm" && !ctx.network.action_kinds[kind]) throw new ActionInvalid([`${kind} is not an action kind`]);
  if (payload !== undefined && payload !== null && (typeof payload !== "object" || Array.isArray(payload))) {
    throw new ActionInvalid(["payload must be an object"]);
  }
  const spec = specFor(ctx, kind);
  if ("error" in spec) throw new ActionInvalid([spec.error]);
  return spec.validate(ctx, typeof target === "string" ? target : "", (payload ?? {}) as Payload);
}

/**
 * The risk a checked request carries at least: the kind's floor, raised by the request
 * itself. The kind's own rule applies even when it is carried out by hand.
 */
export function actionRisk(ctx: Ctx, kind: string, n: Normalised): Risk {
  const own = ACTIONS[kind]?.risk?.(n) ?? "low";
  return maxRisk(toRisk(ctx.network.action_kinds[kind]?.risk), own);
}

/** What approving this decision does, field by field, for the approval card. */
export function describeAction(d: Pick<Decision, "kind" | "target" | "payload">): ActionView {
  return (ACTIONS[d.kind] ?? manual).describe(d.target, safeJson(d.payload));
}

export async function executeAction(ctx: Ctx, d: Decision): Promise<ExecResult> {
  const spec = specFor(ctx, d.kind);
  if ("error" in spec) return { ok: false, result: spec.error };
  let n: Normalised;
  try {
    // Checked again here, in case the config or people changed since the request.
    n = spec.validate(ctx, d.target, safeJson(d.payload));
  } catch (e) {
    if (!(e instanceof ActionInvalid)) throw e;
    return { ok: false, result: `Not done; the request doesn't pass the gateway's checks:\n- ${e.problems.join("\n- ")}` };
  }
  return spec.execute(ctx, d, n);
}
