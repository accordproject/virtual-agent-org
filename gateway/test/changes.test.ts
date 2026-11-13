import { describe, expect, it } from "vitest";
import { ActionInvalid, actionRisk, validateAction } from "../src/actions";
import { changeBrief, tickChanges, verdictFor } from "../src/changes";
import type { Ctx } from "../src/context";
import { approve } from "../src/controls";
import { GitHub } from "../src/github";
import { handleTool, ToolDenied, ToolError } from "../src/tools";
import { processSession } from "../src/sessions";
import { gatherStatus, statusCards, statusPlain } from "../src/status";
import { DEPLOYED, NETWORK, fakeGitHub, makeTestCtx } from "./helpers";

describe("changes", () => {
  it("changes are created as C-n and found by task", async () => {
    const { ctx } = makeTestCtx();
    const base = { agent: "mira", decision_id: "D-1", change_type: "spec", measure: "approval_rate", kinds: ["github.review"] };
    const a = await ctx.db.createChange(base);
    const b = await ctx.db.createChange({ ...base, agent: "network", tool: "request_action" });
    expect([a.id, b.id]).toEqual(["C-1", "C-2"]);
    expect(a.state).toBe("building");
    expect(b.tool).toBe("request_action");

    await ctx.db.updateChange("C-1", { task_id: "T-5", state: "pr_open" });
    expect((await ctx.db.changeForTask("T-5"))?.id).toBe("C-1");
    expect(await ctx.db.changeForTask("T-9")).toBeNull();
    expect((await ctx.db.changesIn(["pr_open"])).map((c) => c.id)).toEqual(["C-1"]);
    expect((await ctx.db.getChange("C-2"))?.state).toBe("building");
  });
});

const DAY = 86_400_000;
const run = (ctx: Ctx, q: string, ...args: unknown[]) => (ctx.db as any).db.prepare(q).bind(...args).run();
/** Moves a decision's request back `days`, out of the one-proposal-a-week window. */
const backdate = (ctx: Ctx, id: string, days = 8) => run(ctx, "UPDATE decisions SET created_at = datetime('now', ?) WHERE id = ?", `-${days} days`, id);
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A test network with the loop switched on at `since`, and Mandla deployed. */
function loopCtx(since: string | null = isoDay(Date.now() - 30 * DAY), overrides: Partial<Ctx> = {}) {
  return makeTestCtx({
    ...overrides,
    network: { ...NETWORK, self_improvement: { ...NETWORK.self_improvement!, since } },
    deployed: {
      ...DEPLOYED,
      agents: { ...DEPLOYED.agents, mandla: { agent_id: "agent_mandla", environment_id: "env_1", vault_ids: [], memory_store_ids: ["mem_mandla"], session_budget_cents: 100 } },
    },
  });
}

/** Decided decisions for `agent`, for the evidence guard and as evidence. */
async function decided(ctx: Ctx, agent: string, n: number, kind = "github.comment") {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = await ctx.db.createDecision({ agent, kind, target: "accordproject/concerto#1", summary: "s", rationale: "r", risk: "low" });
    await ctx.db.decide(d.id, i % 2 ? "rejected" : "approved");
    ids.push(d.id);
  }
  return ids;
}

const PAYLOAD = {
  change_type: "wording",
  problem: "Mira's comments are rejected for tone.",
  change: "Add to step 3: thank the contributor first.",
  evidence: ["D-1"],
  measure: "approval_rate",
};

const problems = (ctx: Ctx, target: string, payload: unknown): string[] => {
  try {
    validateAction(ctx, "spec.change", target, payload);
    return [];
  } catch (e) {
    if (!(e instanceof ActionInvalid)) throw e;
    return e.problems;
  }
};

const propose = (ctx: Ctx, target: string, payload: unknown, session = "sesn_ada") =>
  handleTool(ctx, "ada", session, "request_action", { kind: "spec.change", target, summary: "Change Mira's tone", rationale: "Rejections", risk: "low", payload });

describe("spec.change proposals", () => {
  it("spec.change refuses an unknown type, measure or evidence id", () => {
    const { ctx } = loopCtx();
    const p = problems(ctx, "mira", { ...PAYLOAD, change_type: "rewrite", measure: "vibes", evidence: ["see chat"] });
    expect(p).toHaveLength(3);
    expect(p[0]).toMatch(/change_type must be one of wording, tier, tool/);
    expect(p[1]).toMatch(/see chat/);
    expect(p[2]).toMatch(/measure must be one of approval_rate/);
    expect(problems(ctx, "mira", PAYLOAD)).toEqual([]);
    expect(problems(ctx, "network", PAYLOAD)).toEqual([]);
    expect(problems(ctx, "nobody", PAYLOAD)).toEqual(["target must be an agent, e.g. mira, or network"]);
    expect(problems(ctx, "mira", { ...PAYLOAD, evidence: [] })).toEqual(["payload.evidence needs 1 to 30 ids"]);
  });

  it("spec.change refuses evidence decisions that don't exist", async () => {
    const { ctx } = loopCtx();
    await decided(ctx, "mira", 10);
    await expect(propose(ctx, "mira", { ...PAYLOAD, evidence: ["D-1", "D-999"] })).rejects.toThrow("evidence D-999 is not a decision");
    await expect(propose(ctx, "mira", { ...PAYLOAD, evidence: ["T-4"] })).rejects.toThrow("evidence T-4 is not a task");
    expect(await ctx.db.listDecisions({ status: "open" })).toHaveLength(0);
  });

  it("tool_refusals needs a known tool", () => {
    const { ctx } = loopCtx();
    expect(problems(ctx, "mira", { ...PAYLOAD, measure: "tool_refusals" })).toEqual(["payload.tool is required for tool_refusals"]);
    expect(problems(ctx, "mira", { ...PAYLOAD, measure: "tool_refusals", tool: "nope" })).toEqual(["nope is not a gateway tool"]);
    expect(problems(ctx, "mira", { ...PAYLOAD, measure: "tool_refusals", tool: "label_pr" })).toEqual([]);
    expect(problems(ctx, "mira", { ...PAYLOAD, tool: "label_pr" })).toEqual(["payload.tool is only for tool_refusals"]);
  });

  it("risk follows the change type", async () => {
    const { ctx } = loopCtx();
    await decided(ctx, "mira", 10);
    const cases: [string, string, string][] = [
      ["mira", "wording", "low"],
      ["mira", "tool", "medium"],
      ["mira", "permission", "high"],
      ["mandla", "wording", "high"],
    ];
    for (const [target, change_type, risk] of cases) {
      const out = await propose(ctx, target, { ...PAYLOAD, change_type });
      const id = out.match(/D-\d+/)![0];
      expect((await ctx.db.getDecision(id))?.risk, `${target} ${change_type}`).toBe(risk);
      await backdate(ctx, id);
    }
  });

  it("a type's risk holds when spec.change is carried out by hand", () => {
    const { ctx } = makeTestCtx({ network: { ...NETWORK, action_kinds: { ...NETWORK.action_kinds, "spec.change": { risk: "low", executor: "manual" } } } });
    const n = validateAction(ctx, "spec.change", "mira", { ...PAYLOAD, change_type: "permission" });
    expect(actionRisk(ctx, "spec.change", n)).toBe("high");
    expect(actionRisk(ctx, "spec.change", validateAction(ctx, "spec.change", "mira", PAYLOAD))).toBe("low");
  });

  it("one proposal per agent a week", async () => {
    const { ctx } = loopCtx();
    await decided(ctx, "mira", 10);
    const first = (await propose(ctx, "mira", PAYLOAD)).match(/D-\d+/)![0];
    await ctx.db.decide(first, "rejected");
    const refused = propose(ctx, "mira", PAYLOAD);
    await expect(refused).rejects.toBeInstanceOf(ToolError);
    await expect(refused).rejects.toThrow(new RegExp(`mira already has a proposal from the last 7 days: ${first}`));
    // Other targets have their own week.
    expect(await propose(ctx, "network", PAYLOAD)).toMatch(/^Queued as D-\d+/);
    await backdate(ctx, first);
    expect(await propose(ctx, "mira", PAYLOAD)).toMatch(/^Queued as D-\d+/);
  });

  it("the gap between proposals and the evidence rule are settings", async () => {
    // Each starts with D-1, Otto's, as evidence; it doesn't count towards Mira's.
    const settling = async (si: object) => {
      const { ctx } = loopCtx(isoDay(Date.now()));
      const c = { ...ctx, network: { ...ctx.network, self_improvement: { ...ctx.network.self_improvement!, ...si } } } as Ctx;
      await decided(c, "otto", 1);
      return c;
    };
    // min_days 0: no evidence needed from the start; a 1-day gap.
    const daily = await settling({ proposal_gap_days: 1, min_days: 0 });
    const first = (await propose(daily, "mira", PAYLOAD)).match(/D-\d+/)![0];
    await expect(propose(daily, "mira", PAYLOAD)).rejects.toThrow(`mira already has a proposal from the last 1 days: ${first}. Propose at most one change per agent every 1 days`);
    await backdate(daily, first, 2);
    expect(await propose(daily, "mira", PAYLOAD)).toMatch(/^Queued as D-\d+/);
    // A gap of 0 is no limit.
    const open = await settling({ proposal_gap_days: 0, min_days: 0 });
    expect(await propose(open, "mira", PAYLOAD)).toMatch(/^Queued as D-\d+/);
    expect(await propose(open, "mira", PAYLOAD)).toMatch(/^Queued as D-\d+/);
    // The evidence rule reads min_decided and min_days.
    const strict = await settling({ min_decided: 2, min_days: 5 });
    await expect(propose(strict, "mira", PAYLOAD)).rejects.toThrow(/0 decided decisions.*need 2, or 5 days/s);
    await decided(strict, "mira", 2);
    expect(await propose(strict, "mira", PAYLOAD)).toMatch(/^Queued as D-\d+/);
  });

  it("repeat_rejections needs a rejected decision by the target", async () => {
    const { ctx } = loopCtx();
    await decided(ctx, "mira", 10); // D-2, D-4, ... are rejected
    const [otto] = await decided(ctx, "otto", 2).then((ids) => ids.slice(1)); // D-12, rejected
    const repeat = { ...PAYLOAD, measure: "repeat_rejections" };
    const msg = /repeat_rejections needs the D- id of at least one decision by mira that was rejected/;
    await expect(propose(ctx, "mira", { ...repeat, evidence: ["D-1", "audit:3"] })).rejects.toThrow(msg);
    await expect(propose(ctx, "mira", { ...repeat, evidence: [otto] })).rejects.toThrow(msg);
    const tc = await ctx.db.createDecision({ agent: "mira", kind: "tool.confirm", target: "bash", summary: "s", rationale: "r", risk: "high" });
    await ctx.db.decide(tc.id, "rejected");
    await expect(propose(ctx, "mira", { ...repeat, evidence: [tc.id] })).rejects.toThrow(msg);
    expect(await propose(ctx, "mira", { ...repeat, evidence: ["D-1", "D-2"] })).toMatch(/^Queued as D-\d+/);
    // For the network, any agent's rejection will do.
    expect(await propose(ctx, "network", { ...repeat, evidence: [otto] })).toMatch(/^Queued as D-\d+/);
  });

  it("proposals wait for the loop to start and for evidence", async () => {
    const off = loopCtx(null).ctx;
    await decided(off, "mira", 10);
    await expect(propose(off, "mira", PAYLOAD)).rejects.toThrow("The self-improvement loop is off");

    const { ctx } = loopCtx(isoDay(Date.now()));
    await decided(ctx, "mira", 3);
    // Auto kinds and other agents' decisions don't count.
    await decided(ctx, "mira", 8, "github.approve_ci");
    await decided(ctx, "otto", 8);
    const refused = propose(ctx, "mira", PAYLOAD);
    await expect(refused).rejects.toBeInstanceOf(ToolError);
    await expect(refused).rejects.toThrow(/3 decided decisions.*10.*14 days/s);

    await decided(ctx, "mira", 7);
    expect(await propose(ctx, "mira", PAYLOAD)).toMatch(/^Queued as D-\d+/);
    // For the network as a whole, every agent's decisions count.
    expect(await propose(ctx, "network", PAYLOAD)).toMatch(/^Queued as D-\d+/);

    const later = loopCtx(isoDay(Date.now() + 2 * DAY)).ctx;
    await decided(later, "mira", 10);
    await expect(propose(later, "mira", PAYLOAD)).rejects.toThrow(/starts on/);

    // Fourteen days after the start, the count no longer matters.
    const old = loopCtx(isoDay(Date.now() - 15 * DAY)).ctx;
    await decided(old, "mira", 1);
    expect(await propose(old, "mira", PAYLOAD)).toMatch(/^Queued as D-\d+/);
  });

  it("refuses a proposal from a session a member started", async () => {
    const { ctx } = loopCtx();
    await decided(ctx, "mira", 10);
    await ctx.db.upsertSession({ id: "sesn_m", agent: "ada", origin: "telegram", started_by: "member:telegram:Jane Doe" });
    await expect(propose(ctx, "mira", PAYLOAD, "sesn_m")).rejects.toThrow("Jane Doe is a member");
  });

  it("approving spec.change starts a task for Mandla", async () => {
    const { ctx, fakes } = loopCtx();
    await decided(ctx, "mira", 10);
    await ctx.db.createDecision({ agent: "mira", kind: "github.review", target: "accordproject/concerto#1", summary: "s", rationale: "r", risk: "low" });
    const out = await propose(ctx, "mira", { ...PAYLOAD, evidence: ["D-1", "D-2", "D-11"] });
    const id = out.match(/D-\d+/)![0];

    const reply = await approve(ctx, id);
    const change = (await ctx.db.getChange("C-1"))!;
    expect(change).toMatchObject({ agent: "mira", decision_id: id, change_type: "wording", measure: "approval_rate", state: "building" });
    // Kinds that say nothing about judgement are left out of the measure.
    expect(JSON.parse(change.kinds)).toEqual(["github.comment"]);
    const task = (await ctx.db.openTasks("mandla"))[0];
    expect(task).toMatchObject({ id: change.task_id, kind: "change", status: "running" });
    const sessions = fakes.calls.filter((c) => c.method === "createSession").map((c) => c.args[0] as any);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ agentId: "agent_mandla", budgetCents: 100 });
    expect(sessions[0].model).toBeUndefined();
    expect(sessions[0].text).toContain("C-1");
    const d = (await ctx.db.getDecision(id))!;
    expect(d.status).toBe("executed");
    expect(d.result).toContain("C-1");
    expect(d.result).toContain(task.id);
    expect(reply).toContain("C-1");

    await backdate(ctx, id);
    const tool = await propose(ctx, "mira", { ...PAYLOAD, change_type: "tool" });
    await approve(ctx, tool.match(/D-\d+/)![0]);
    const second = fakes.calls.filter((c) => c.method === "createSession").map((c) => c.args[0] as any)[1];
    expect(second).toMatchObject({ budgetCents: 500, model: { id: NETWORK.model_tiers!.deep, effort: "high" } });
  });

  it("fails the decision if evidence has gone by approval", async () => {
    const { ctx, fakes } = loopCtx();
    await decided(ctx, "mira", 10);
    await propose(ctx, "mira", PAYLOAD);
    await (ctx.db as any).db.prepare("DELETE FROM decisions WHERE id = 'D-1'").run();
    await approve(ctx, "D-11");
    expect((await ctx.db.getDecision("D-11"))?.status).toBe("failed");
    expect(await ctx.db.getChange("C-1")).toBeNull();
    expect(fakes.calls.filter((c) => c.method === "createSession")).toHaveLength(0);
  });

  it("the brief carries the payload, the ids and the fixed boundaries", () => {
    const brief = changeBrief(
      { id: "C-3", agent: "mira" },
      { id: "D-12" },
      { ...PAYLOAD, measure: "tool_refusals", tool: "label_pr", evidence: ["D-1", "audit:7"] },
    );
    for (const s of ["C-3", "D-12", "mira", "wording", PAYLOAD.problem, PAYLOAD.change, "D-1, audit:7", "tool_refusals", "label_pr"]) expect(brief).toContain(s);
    expect(brief).toContain("Change only what the decision approved. Don't change files under .github/ or gateway/src/generated/ by hand; if config changed, run npm run compile and include the regenerated gateway/src/generated/network.json. Never weaken a test. Submit once with submit_change, then report_status.");
  });
});

describe("submit_change", () => {
  /** An approved wording change to Mira, C-1, with Mandla's task running. */
  async function building(dryRun = false) {
    const gh = fakeGitHub();
    const { ctx, fakes } = loopCtx(undefined, { dryRun, github: async () => gh as any });
    await decided(ctx, "mira", 10);
    const out = await propose(ctx, "mira", { ...PAYLOAD, evidence: ["D-1", "D-2"] });
    const decision = out.match(/D-\d+/)![0];
    await approve(ctx, decision);
    const task = (await ctx.db.openTasks("mandla"))[0];
    return { ctx, fakes, gh, decision, session: task.session_id! };
  }

  const INPUT = {
    change: "C-1",
    title: "docs(mira): thank the contributor first",
    body: "Adds a line to step 3 of Mira's spec.",
    files: [{ path: "agents/mira.md", content: "# Mira\n" }],
  };
  const submit = (ctx: Ctx, session: string, input: object = {}, agent = "mandla") =>
    handleTool(ctx, agent, session, "submit_change", { ...INPUT, ...input });

  it("only Mandla's change task may submit", async () => {
    const { ctx, session } = await building();
    await expect(submit(ctx, session, {}, "mira")).rejects.toBeInstanceOf(ToolDenied);
    await ctx.db.upsertSession({ id: "sesn_other", agent: "mandla", origin: "task", started_by: "owner" });
    await expect(submit(ctx, "sesn_other")).rejects.toThrow("Only Mandla's task for an approved change can submit");
    await expect(submit(ctx, session, { change: "C-2" })).rejects.toThrow("This task is for C-1, not C-2");
  });

  it("submit_change refuses unsafe paths before calling GitHub", async () => {
    const { ctx, session, gh } = await building();
    const bad = [".github/workflows/ci.yml", "../x", "/etc/x", "gateway/src/generated/deployed.json", "", "agents\\mira.md"];
    const files = [...bad.map((path) => ({ path, content: "x" })), { path: "a.md", content: "x" }, { path: "a.md", delete: true }, { path: "b.md" }, { path: "c.md", content: "x", delete: true }];
    const err = await submit(ctx, session, { files }).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    for (const p of [...bad.slice(0, 4), "files[4] has an empty path", "agents\\mira.md: use /", "a.md more than once", "b.md: give exactly one of content, edits or delete: true", "c.md: give exactly one"]) expect(err.message).toContain(p);
    // Bare directory names, other cases and odd spellings of them are refused too.
    const dirs = [{ path: ".github", delete: true }, { path: ".GITHUB/x", content: "x" }, { path: "./.github/x", content: "x" }, { path: "a//b", content: "x" }, { path: "gateway/src/generated", delete: true }];
    const more = await submit(ctx, session, { files: dirs }).catch((e) => e);
    expect(more).toBeInstanceOf(ToolError);
    for (const p of [".github: files under .github/", ".GITHUB/x: files under .github/", "./.github/x: give a plain path", "a//b: give a plain path", "gateway/src/generated: files under gateway/src/generated/"]) expect(more.message).toContain(p);
    expect(gh.proposed).toHaveLength(0);
    expect((await ctx.db.getChange("C-1"))?.state).toBe("building");
  });

  it("submit_change accepts the regenerated network.json, and nothing else generated", async () => {
    const { ctx, session, gh } = await building();
    const err = await submit(ctx, session, { files: [{ path: "gateway/src/generated/network.json", content: "{}" }, { path: "gateway/src/generated/other.json", content: "{}" }] }).catch((e) => e);
    expect(err.message).not.toContain("network.json");
    expect(err.message).toContain("gateway/src/generated/other.json: files under gateway/src/generated/");
    expect(await submit(ctx, session, { files: [...INPUT.files, { path: "gateway/src/generated/network.json", content: "{}" }] })).toContain("/pull/1");
    expect(gh.proposed[0][1].files.map((f: any) => f.path)).toEqual(["agents/mira.md", "gateway/src/generated/network.json"]);
  });

  it("submit_change checks the title and body", async () => {
    const { ctx, session } = await building();
    await expect(submit(ctx, session, { title: "Thank contributors" })).rejects.toThrow(/Conventional Commits/);
    await expect(submit(ctx, session, { title: `docs: ${"x".repeat(100)}` })).rejects.toThrow(/100/);
    await expect(submit(ctx, session, { body: "x".repeat(20_001) })).rejects.toThrow(/20,000/);
    // A title is one line: no forged trailers in the commit message.
    for (const title of ["docs: x\n\nSigned-off-by: Someone Else <a@b>\nChange: C-9", "docs: x\rmore", "docs: x\u0000", "docs: x\tthen"]) {
      await expect(submit(ctx, session, { title })).rejects.toThrow(/title must be one line, without control characters/);
    }
  });

  it("submit_change refuses more than 50 files or 500,000 characters", async () => {
    const { ctx, session, gh } = await building();
    const many = Array.from({ length: 51 }, (_, i) => ({ path: `docs/${i}.md`, content: "x" }));
    await expect(submit(ctx, session, { files: many })).rejects.toThrow(/51 files.*50/);
    const big = [{ path: "a.md", content: "x".repeat(300_000) }, { path: "b.md", content: "x".repeat(200_001) }];
    await expect(submit(ctx, session, { files: big })).rejects.toThrow(/500,000/);
    await expect(submit(ctx, session, { files: [] })).rejects.toThrow(/at least one file/);
    expect(gh.proposed).toHaveLength(0);
  });

  it("submit_change opens one PR on the network repo", async () => {
    const { ctx, session, gh, decision } = await building();
    const out = await submit(ctx, session, { files: [...INPUT.files, { path: "old.md", delete: true }] });
    expect(out).toContain("https://github.com/accordproject/virtual-agent-org/pull/1");
    expect(gh.proposed).toHaveLength(1);
    const [ref, p] = gh.proposed[0];
    expect(ref).toEqual({ owner: "accordproject", repo: "virtual-agent-org" });
    expect(p.branch).toBe("change/c-1");
    expect(p.files).toEqual([{ path: "agents/mira.md", content: "# Mira\n" }, { path: "old.md", content: null }]);
    const author = NETWORK.self_improvement!.commit_author;
    expect(p.author).toEqual(author);
    expect(p.message).toBe(`${INPUT.title}\n\nChange: C-1\nDecision: ${decision}\n\nSigned-off-by: ${author.name} <${author.email}>`);
    expect(p.title).toBe(INPUT.title);
    for (const s of [decision, "D-1, D-2", "approval_rate", "Built by Mandla; needs the owner's review like any other PR.", "## Change", INPUT.body]) expect(p.body).toContain(s);
    expect(p.body.split("\n")).toContain("Change: C-1");

    const change = (await ctx.db.getChange("C-1"))!;
    expect(change).toMatchObject({ state: "pr_open", pr_url: "https://github.com/accordproject/virtual-agent-org/pull/1" });
    expect(change.pr_opened_at).toBeTruthy();
    const audit = await (ctx.db as any).db.prepare("SELECT agent, detail FROM audit WHERE event_type = 'gateway.change_pr_opened'").all();
    expect(audit.results).toHaveLength(1);
    expect(JSON.parse(audit.results[0].detail)).toEqual({ change: "C-1", decision, pr: change.pr_url });
  });

  it("submit_change makes edits to the files on the default branch, and builds on the commit it read", async () => {
    const { ctx, session, gh } = await building();
    gh.repoFiles["agents/mira.md"] = "# Mira\n\n1. Read the PR.\n2. Review it.\n";
    gh.repoFiles["gateway/src/x.ts"] = "const a = 1;\nconst b = 2;\n";
    const out = await submit(ctx, session, {
      files: [
        { path: "agents/mira.md", edits: [{ old: "1. Read the PR.\n", new: "1. Thank the contributor.\n2. Read the PR.\n" }, { old: "2. Review it.", new: "3. Review it." }] },
        { path: "gateway/src/x.ts", edits: [{ old: "const b = 2;\n", new: "" }] },
        { path: "docs/new.md", content: "New\n" },
        { path: "old.md", delete: true },
      ],
    });
    expect(out).toContain("/pull/1");
    const [, p] = gh.proposed[0];
    expect(p.base).toBe("basecommit1");
    expect(gh.fileReads).toEqual([{ path: "agents/mira.md", ref: "basecommit1" }, { path: "gateway/src/x.ts", ref: "basecommit1" }]);
    expect(p.files).toEqual([
      { path: "agents/mira.md", content: "# Mira\n\n1. Thank the contributor.\n2. Read the PR.\n3. Review it.\n" },
      { path: "gateway/src/x.ts", content: "const a = 1;\n" },
      { path: "docs/new.md", content: "New\n" },
      { path: "old.md", content: null },
    ]);
  });

  it("submit_change without edits reads nothing and builds on the current head", async () => {
    const { ctx, session, gh } = await building();
    await submit(ctx, session);
    expect(gh.fileReads).toHaveLength(0);
    expect(gh.proposed[0][1].base).toBeUndefined();
  });

  it("submit_change refuses edits that aren't found exactly once, or files that don't exist, and opens nothing", async () => {
    const { ctx, session, gh } = await building();
    gh.repoFiles["agents/mira.md"] = "step\nstep\nonce\n";
    const err = await submit(ctx, session, {
      files: [
        { path: "agents/mira.md", edits: [{ old: "missing", new: "x" }, { old: "step", new: "x" }, { old: "once", new: "twice" }] },
        { path: "agents/nobody.md", edits: [{ old: "a", new: "b" }] },
      ],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.message).toMatch(/^Not submitted\. Fix these and call again/);
    for (const s of ["agents/mira.md: edit 1's old text isn't in the file", "agents/mira.md: edit 2's old text appears more than once", "agents/nobody.md: not on the default branch"]) expect(err.message).toContain(s);
    expect(err.message).not.toContain("edit 3");
    expect(gh.proposed).toHaveLength(0);
    expect((await ctx.db.getChange("C-1"))?.state).toBe("building");
  });

  it("submit_change checks the shape of edits before calling GitHub", async () => {
    const { ctx, session, gh } = await building();
    const err = await submit(ctx, session, {
      files: [
        { path: "a.md", edits: [] },
        { path: "b.md", edits: [{ old: "", new: "x" }, { old: "y", new: "y" }] },
        { path: "c.md", edits: [{ old: "a", new: "b" }], content: "x" },
        { path: "d.md", edits: [{ old: "a", new: "b" }], delete: true },
      ],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    for (const s of ["a.md: edits needs at least one edit", "b.md: edit 1 needs old", "b.md: edit 2 changes nothing", "c.md: give exactly one of content, edits or delete: true", "d.md: give exactly one of content, edits or delete: true"]) expect(err.message).toContain(s);
    // The tool's schema refuses an edit without new before the gateway's own checks.
    await expect(submit(ctx, session, { files: [{ path: "b.md", edits: [{ old: "z" }] }] })).rejects.toThrow("files[0].edits[0].new is required");
    expect(gh.fileReads).toHaveLength(0);
    expect(gh.proposed).toHaveLength(0);
  });

  it("a change is submitted once", async () => {
    const { ctx, session, gh } = await building();
    await submit(ctx, session);
    await expect(submit(ctx, session)).rejects.toThrow("C-1 already has a PR: https://github.com/accordproject/virtual-agent-org/pull/1");
    expect(gh.proposed).toHaveLength(1);
  });

  it("a GitHub failure leaves the change building", async () => {
    const { ctx, session, gh } = await building();
    gh.failPropose = "GitHub POST /repos/accordproject/virtual-agent-org/git/trees: 422 bad tree";
    const err = await submit(ctx, session).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.message).toContain("422 bad tree");
    expect((await ctx.db.getChange("C-1"))?.state).toBe("building");
    gh.failPropose = null;
    expect(await submit(ctx, session)).toContain("/pull/1");
    expect((await ctx.db.getChange("C-1"))?.state).toBe("pr_open");
    // C-7: the failed attempt may have left a branch and commit, so it is recorded too.
    const writes = await ctx.db.githubWrites("2000-01-01", "9999-12-31");
    expect(writes.map((w) => [w.tool, w.args, w.ok])).toEqual([
      ["submit_change", { repo: "accordproject/virtual-agent-org", number: null, fields: ["branch", "files", "title", "body"] }, false],
      ["submit_change", { repo: "accordproject/virtual-agent-org", number: 1, fields: ["branch", "files", "title", "body"] }, true],
    ]);
  });

  it("dry run doesn't open a PR, and closes the change so the task ends done", async () => {
    const { ctx, fakes, session, gh } = await building(true);
    expect(await submit(ctx, session)).toMatch(/^DRY RUN: would open a PR for C-1/);
    expect(gh.proposed).toHaveLength(0);
    expect(await ctx.db.getChange("C-1")).toMatchObject({ state: "closed", closed_reason: "dry run" });
    fakes.sessions[session] = { id: session, status: "idle", agent: { id: "agent_mandla" }, stop_reason: { type: "end_turn" } };
    fakes.events[session] = [];
    await processSession(ctx, session);
    const task = (await ctx.db.sessionTask(session))!;
    expect((await ctx.db.getTask(task.id))?.status).toBe("done");
    expect(fakes.calls.filter((c) => c.method === "createSession" && (c.args[0] as any).agentId === "agent_ada")).toHaveLength(0);
  });

  it("proposeChange makes one commit through the Git data API", async () => {
    const calls: [string, string, any][] = [];
    const R = "/repos/accordproject/virtual-agent-org";
    const fetchImpl = (async (url: string, init: any) => {
      const path = new URL(url).pathname;
      calls.push([init.method, path, init.body ? JSON.parse(init.body) : undefined]);
      const body =
        path === R ? { default_branch: "main" }
        : path === `${R}/git/ref/heads/main` ? { object: { sha: "head1" } }
        : path === `${R}/git/commits/head1` ? { tree: { sha: "tree1" } }
        : path === `${R}/git/trees` ? { sha: "tree2" }
        : path === `${R}/git/commits` ? { sha: "commit2" }
        : path === `${R}/pulls` ? { html_url: "https://github.com/accordproject/virtual-agent-org/pull/7", number: 7 }
        : {};
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const author = { name: "bot", email: "bot@example.com" };
    const pr = await new GitHub("t", fetchImpl).proposeChange(
      { owner: "accordproject", repo: "virtual-agent-org" },
      { branch: "change/c-1", files: [{ path: "a.md", content: "A" }, { path: "b.md", content: null }], message: "docs: x", author, title: "docs: x", body: "B" },
    );
    expect(pr).toEqual({ html_url: "https://github.com/accordproject/virtual-agent-org/pull/7", number: 7 });
    const post = (p: string) => calls.find((c) => c[0] === "POST" && c[1] === `${R}${p}`)?.[2];
    expect(post("/git/trees")).toEqual({
      base_tree: "tree1",
      tree: [{ path: "a.md", mode: "100644", type: "blob", content: "A" }, { path: "b.md", mode: "100644", type: "blob", sha: null }],
    });
    expect(post("/git/commits")).toEqual({ message: "docs: x", tree: "tree2", parents: ["head1"], author });
    expect(post("/git/refs")).toEqual({ ref: "refs/heads/change/c-1", sha: "commit2" });
    expect(post("/pulls")).toEqual({ title: "docs: x", head: "change/c-1", base: "main", body: "B" });
  });

  it("GitHub.proposeChange builds on a given base commit, and fileText reads a file at a commit", async () => {
    const calls: [string, string][] = [];
    const R = "/repos/accordproject/virtual-agent-org";
    const text = "café\nline two\n";
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(text)));
    const fetchImpl = (async (url: string, init: any) => {
      const u = new URL(url);
      calls.push([init.method, u.pathname + u.search]);
      if (u.pathname === `${R}/contents/agents/gone.md`) return new Response('{"message":"Not Found"}', { status: 404 });
      const body =
        u.pathname === R ? { default_branch: "main" }
        : u.pathname === `${R}/git/ref/heads/main` ? { object: { sha: "head1" } }
        // GitHub wraps base64 content at 60 characters.
        : u.pathname === `${R}/contents/agents/mira.md` ? { type: "file", encoding: "base64", content: b64.replace(/(.{8})/g, "$1\n") }
        : u.pathname === `${R}/git/commits/base0` ? { tree: { sha: "tree0" } }
        : u.pathname === `${R}/git/trees` ? { sha: "tree2" }
        : u.pathname === `${R}/git/commits` ? { sha: "commit2" }
        : u.pathname === `${R}/pulls` ? { html_url: "https://github.com/accordproject/virtual-agent-org/pull/8", number: 8 }
        : {};
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const gh = new GitHub("t", fetchImpl);
    const r = { owner: "accordproject", repo: "virtual-agent-org" };
    expect(await gh.defaultHead(r)).toEqual({ branch: "main", sha: "head1" });
    expect(await gh.fileText(r, "agents/mira.md", "base0")).toBe(text);
    expect(calls).toContainEqual(["GET", `${R}/contents/agents/mira.md?ref=base0`]);
    expect(await gh.fileText(r, "agents/gone.md", "base0")).toBeNull();

    calls.length = 0;
    await gh.proposeChange(r, { branch: "change/c-2", files: [{ path: "a.md", content: "A" }], message: "m", author: { name: "b", email: "b@x" }, title: "t", body: "B", base: "base0" });
    expect(calls.map((c) => c[1])).not.toContain(`${R}/git/ref/heads/main`);
    expect(calls).toContainEqual(["GET", `${R}/git/commits/base0`]);
  });
});

describe("Mandla's tasks that end without a PR", () => {
  const end = async (ctx: Ctx, fakes: any, sid: string, blocked: string[] = []) => {
    fakes.sessions[sid] = { id: sid, status: "idle", agent: { id: "agent_mandla" }, stop_reason: { type: "end_turn" } };
    fakes.events[sid] = [{ id: `${sid}_e1`, type: "agent.custom_tool_use", name: "report_status", input: { done: [], doing: [], blocked } }];
    await processSession(ctx, sid);
  };
  const follow = (ctx: Ctx, agent: string, follows_up: string) =>
    handleTool(ctx, "ada", "sesn_ada", "assign_task", {
      agent, title: "Retry C-1", objective: "Finish the change", output: "A PR", done_when: "submit_change succeeded", effort: "small", follows_up,
    });
  /** C-1 approved, its task for Mandla running. */
  async function approved(change_type = "wording") {
    const gh = fakeGitHub();
    const { ctx, fakes } = loopCtx(undefined, { dryRun: false, github: async () => gh as any });
    await decided(ctx, "mira", 10);
    const out = await propose(ctx, "mira", { ...PAYLOAD, change_type, evidence: ["D-1", "D-2"] });
    await approve(ctx, out.match(/D-\d+/)![0]);
    const task = (await ctx.db.openTasks("mandla"))[0];
    return { ctx, fakes, task, gh };
  }
  /** C-1 approved, its Mandla session ended without submitting. */
  async function blocked(change_type = "wording") {
    const r = await approved(change_type);
    await end(r.ctx, r.fakes, r.task.session_id!);
    return r;
  }
  const mandlaSessions = (fakes: any) => fakes.calls.filter((c: any) => c.method === "createSession" && c.args[0].agentId === "agent_mandla").map((c: any) => c.args[0]);
  const wakes = (fakes: any) => fakes.calls.filter((c: any) => c.method === "createSession" && c.args[0].agentId === "agent_ada");

  it("a task for Mandla that ends without submitting is blocked", async () => {
    const { ctx, fakes, task } = await blocked();
    expect(await ctx.db.getTask(task.id)).toMatchObject({ status: "blocked", blocked_reason: "C-1: no change submitted" });
    const audit = await (ctx.db as any).db.prepare("SELECT detail FROM audit WHERE event_type = 'gateway.task_blocked'").all();
    expect(audit.results[0].detail).toContain("C-1: no change submitted");
    expect((await ctx.db.getChange("C-1"))?.state).toBe("building");
    expect(wakes(fakes).length).toBeGreaterThan(0);
  });

  it("a Mandla session that runs out of budget or is ended is blocked like one that ends its turn, with the change in blocked_reason", async () => {
    const endings: [object, string][] = [
      [{ status: "idle", stop_reason: { type: "budget_reached" } }, "C-1: no change submitted (budget reached)"],
      [{ status: "terminated" }, "C-1: no change submitted (session ended)"],
    ];
    for (const [session, blocker] of endings) {
      const { ctx, fakes, task } = await approved();
      const sid = task.session_id!;
      fakes.sessions[sid] = { id: sid, agent: { id: "agent_mandla" }, ...session };
      fakes.events[sid] = [];
      await processSession(ctx, sid);
      expect(await ctx.db.getTask(task.id)).toMatchObject({ status: "blocked", blocked_reason: blocker });
      const audit = await (ctx.db as any).db.prepare("SELECT detail FROM audit WHERE event_type = 'gateway.task_blocked'").all();
      expect(audit.results[0].detail).toContain(blocker);
      expect((await ctx.db.getChange("C-1"))?.state).toBe("building");
      expect(wakes(fakes).length).toBeGreaterThan(0);
    }
  });

  it("a Mandla session that runs out of budget or is ended after its PR opened leaves the task done, and doesn't wake Ada (decision 74)", async () => {
    for (const session of [{ status: "idle", stop_reason: { type: "budget_reached" } }, { status: "terminated" }]) {
      const { ctx, fakes, task } = await approved();
      const sid = task.session_id!;
      expect(await handleTool(ctx, "mandla", sid, "submit_change", {
        change: "C-1", title: "docs(mira): thank the contributor first", body: "Adds a line.", files: [{ path: "agents/mira.md", content: "# Mira\n" }],
      })).toContain("/pull/1");
      fakes.sessions[sid] = { id: sid, agent: { id: "agent_mandla" }, ...session };
      fakes.events[sid] = [];
      await processSession(ctx, sid);
      expect(await ctx.db.getTask(task.id)).toMatchObject({ status: "done" });
      const audit = await (ctx.db as any).db.prepare("SELECT detail FROM audit WHERE event_type = 'gateway.task_blocked'").all();
      expect(audit.results).toHaveLength(0);
      expect(wakes(fakes)).toHaveLength(0);
      expect((await ctx.db.getChange("C-1"))?.state).toBe("pr_open");
    }
  });

  /** C-1 approved; Mandla reports `before`, submits, maybe reports `after`, then runs out of budget. */
  async function reportSubmitRunOut(before: string[], after?: string[]) {
    const r = await approved();
    const sid = r.task.session_id!;
    const report = (blocked: string[]) => handleTool(r.ctx, "mandla", sid, "report_status", { done: [], doing: [], blocked });
    await report(before);
    // The earlier report was made a minute before the PR opened.
    await (r.ctx.db as any).db.prepare("UPDATE statuses SET created_at = datetime('now', '-1 minute') WHERE session_id = ?").bind(sid).run();
    await handleTool(r.ctx, "mandla", sid, "submit_change", {
      change: "C-1", title: "docs(mira): thank the contributor first", body: "Adds a line.", files: [{ path: "agents/mira.md", content: "# Mira\n" }],
    });
    if (after) await report(after);
    r.fakes.sessions[sid] = { id: sid, agent: { id: "agent_mandla" }, status: "idle", stop_reason: { type: "budget_reached" } };
    r.fakes.events[sid] = [];
    await processSession(r.ctx, sid);
    return r;
  }

  it("a blocker reported before the PR opened doesn't block a submitted change", async () => {
    const { ctx, fakes, task } = await reportSubmitRunOut(["npm test fails on a fresh clone"]);
    expect(await ctx.db.getTask(task.id)).toMatchObject({ status: "done" });
    expect(wakes(fakes)).toHaveLength(0);
  });

  it("a blocker reported after the PR opened still blocks the task and wakes Ada", async () => {
    const { ctx, fakes, task } = await reportSubmitRunOut([], ["CI fails on the PR"]);
    expect(await ctx.db.getTask(task.id)).toMatchObject({ status: "blocked" });
    const audit = await (ctx.db as any).db.prepare("SELECT detail FROM audit WHERE event_type = 'gateway.task_blocked'").all();
    expect(audit.results[0].detail).toContain("CI fails on the PR");
    expect(audit.results[0].detail).not.toContain("Ran out of its session budget");
    expect(wakes(fakes).length).toBeGreaterThan(0);
  });

  it("a change follow-up gets the change's budget and tier, not Ada's effort", async () => {
    const small = await blocked();
    await follow(small.ctx, "mandla", small.task.id);
    expect(mandlaSessions(small.fakes).at(-1)).toMatchObject({ budgetCents: 100 });
    expect(mandlaSessions(small.fakes).at(-1).model).toBeUndefined();
    expect(mandlaSessions(small.fakes).at(-1).text).toContain("$1.00");

    const large = await blocked("tool");
    await follow(large.ctx, "mandla", large.task.id);
    expect(mandlaSessions(large.fakes).at(-1)).toMatchObject({ budgetCents: 500, model: { id: NETWORK.model_tiers!.deep, effort: "high" } });
  });

  it("a member can't set Mandla going through Ada", async () => {
    const { ctx, task, fakes } = await blocked();
    await ctx.db.upsertSession({ id: "sesn_m", agent: "ada", origin: "telegram", started_by: "member:telegram:Jane Doe" });
    const before = mandlaSessions(fakes).length;
    const out = handleTool(ctx, "ada", "sesn_m", "assign_task", {
      agent: "mandla", title: "Retry C-1", objective: "Finish", output: "A PR", done_when: "done", effort: "small", follows_up: task.id,
    });
    await expect(out).rejects.toBeInstanceOf(ToolDenied);
    await expect(out).rejects.toThrow("Jane Doe is a member");
    expect(mandlaSessions(fakes)).toHaveLength(before);
    expect((await ctx.db.getChange("C-1"))?.task_id).toBe(task.id);
  });

  it("a follow-up of a blocked change task takes over the change", async () => {
    const { ctx, task, gh } = await blocked();
    expect(await follow(ctx, "mandla", task.id)).toMatch(/^Assigned T-\d+ to Mandla/);
    const next = (await ctx.db.openTasks("mandla")).find((t) => t.follows_up === task.id)!;
    expect(next.kind).toBe("change");
    expect(next.brief).toContain("C-1");
    expect((await ctx.db.getChange("C-1"))?.task_id).toBe(next.id);

    const out = await handleTool(ctx, "mandla", next.session_id!, "submit_change", {
      change: "C-1", title: "docs(mira): thank first", body: "b", files: [{ path: "agents/mira.md", content: "x" }],
    });
    expect(out).toContain("/pull/1");
    expect(gh.proposed).toHaveLength(1);
    expect((await ctx.db.getChange("C-1"))?.state).toBe("pr_open");
  });

  it("a change follow-up can only go to Mandla", async () => {
    const { ctx, task } = await blocked();
    await expect(follow(ctx, "mira", task.id)).rejects.toThrow("only Mandla can follow it up");
    expect((await ctx.db.getChange("C-1"))?.task_id).toBe(task.id);
  });

  it("Mandla only gets tasks that follow up a change", async () => {
    const { ctx } = loopCtx();
    const plain = await ctx.db.createTask({ agent: "mira", title: "t", brief: "b" });
    const msg = "Mandla only works on approved changes: propose one with spec.change.";
    await expect(handleTool(ctx, "ada", "sesn_ada", "assign_task", { agent: "mandla", title: "x", objective: "o", output: "o", done_when: "d", effort: "small" })).rejects.toThrow(msg);
    await expect(follow(ctx, "mandla", plain.id)).rejects.toThrow(msg);
  });

  it("Ada closing a blocked change task closes its change too", async () => {
    const { ctx, task } = await blocked();
    const out = await handleTool(ctx, "ada", "sesn_ada", "close_task", { id: task.id, note: "superseded by a new proposal" });
    expect(out).toBe(`${task.id} closed, and with it C-1. Report both under "Decided for you".`);
    expect((await ctx.db.getTask(task.id))?.status).toBe("cancelled");
    expect(await ctx.db.getChange("C-1")).toMatchObject({ state: "closed", closed_reason: "closed by Ada" });
    const row: any = await (ctx.db as any).db.prepare("SELECT detail FROM audit WHERE event_type = 'gateway.change_closed'").first();
    expect(JSON.parse(row.detail)).toEqual({ change: "C-1", reason: "closed by Ada" });
  });

  it("Ada closing a change task leaves a change that already has its PR alone", async () => {
    const { ctx, task } = await blocked();
    await ctx.db.updateChange("C-1", { state: "pr_open" });
    expect(await handleTool(ctx, "ada", "sesn_ada", "close_task", { id: task.id, note: "PR is open" })).toBe(`${task.id} closed. Report it under "Decided for you".`);
    expect((await ctx.db.getChange("C-1"))?.state).toBe("pr_open");
  });

  it("a follow-up that is blocked again closes the change", async () => {
    const { ctx, fakes, task } = await blocked();
    await follow(ctx, "mandla", task.id);
    const next = (await ctx.db.openTasks("mandla")).find((t) => t.follows_up === task.id)!;
    const before = wakes(fakes).length;
    await end(ctx, fakes, next.session_id!);
    expect((await ctx.db.getTask(next.id))?.status).toBe("blocked");
    expect(await ctx.db.getChange("C-1")).toMatchObject({ state: "closed", closed_reason: "blocked twice" });
    // Decision 50: a follow-up blocked again goes to the owner through Ada.
    expect(wakes(fakes).length).toBe(before + 1);
    expect(JSON.stringify(wakes(fakes).at(-1).args[0])).toContain(next.id);
    await expect(follow(ctx, "mandla", next.id)).rejects.toThrow(/closed/);
  });
});

describe("follow-ups of a change that has its PR (C-10)", () => {
  const FILES = [{ path: "agents/mira.md", edits: [{ old: "Step 3.", new: "Step 3, thanking first." }] }];
  const submit = (ctx: Ctx, sid: string, input: object = {}) =>
    handleTool(ctx, "mandla", sid, "submit_change", { change: "C-1", title: "fix(mira): thank first", body: "Fixes the review findings.", files: FILES, ...input });
  const end = async (ctx: Ctx, fakes: any, sid: string) => {
    fakes.sessions[sid] = { id: sid, status: "idle", agent: { id: "agent_mandla" }, stop_reason: { type: "end_turn" } };
    fakes.events[sid] = [];
    await processSession(ctx, sid);
  };
  const follow = (ctx: Ctx, follows_up: string) =>
    handleTool(ctx, "ada", "sesn_ada", "assign_task", {
      agent: "mandla", title: "Fix up C-1", objective: "Fix the review findings", output: "A commit", done_when: "submit_change succeeded", effort: "small", follows_up,
    });
  /** C-1 approved, its PR opened by Mandla's first task, which has ended done. */
  async function opened() {
    const gh = fakeGitHub();
    gh.repoFiles["agents/mira.md"] = "# Mira\nStep 3.\n";
    gh.branches["change/c-1"] = "prhead1";
    const { ctx, fakes } = loopCtx(undefined, { dryRun: false, github: async () => gh as any });
    await decided(ctx, "mira", 10);
    const out = await propose(ctx, "mira", { ...PAYLOAD, evidence: ["D-1", "D-2"] });
    const decision = out.match(/D-\d+/)![0];
    await approve(ctx, decision);
    const task = (await ctx.db.openTasks("mandla"))[0];
    expect(await submit(ctx, task.session_id!)).toContain("Opened https://github.com/accordproject/virtual-agent-org/pull/1");
    await end(ctx, fakes, task.session_id!);
    expect((await ctx.db.getTask(task.id))?.status).toBe("done");
    return { ctx, fakes, gh, task, decision };
  }
  const nextTask = async (ctx: Ctx, follows: string) => (await ctx.db.openTasks("mandla")).find((t) => t.follows_up === follows)!;

  it("a follow-up of an open PR's task adds a commit to its branch, built on the branch's head", async () => {
    const { ctx, fakes, gh, task } = await opened();
    expect(await follow(ctx, task.id)).toMatch(/^Assigned T-\d+ to Mandla/);
    const next = await nextTask(ctx, task.id);
    expect(next.kind).toBe("change");
    expect((await ctx.db.getChange("C-1"))?.task_id).toBe(next.id);
    expect(next.brief).toContain("C-1's PR is open: https://github.com/accordproject/virtual-agent-org/pull/1. Build on its branch change/c-1");

    gh.fileReads.length = 0;
    expect(await submit(ctx, next.session_id!)).toBe("Added a commit to https://github.com/accordproject/virtual-agent-org/pull/1 for C-1. The owner reviews it; call report_status and stop.");
    expect(gh.fileReads).toEqual([{ path: "agents/mira.md", ref: "prhead1" }]);
    expect(gh.proposed).toHaveLength(1);
    expect(gh.pushed).toHaveLength(1);
    expect(gh.pushed[0]).toMatchObject({ branch: "change/c-1", base: "prhead1", files: [{ path: "agents/mira.md", content: "# Mira\nStep 3, thanking first.\n" }] });
    expect(gh.pushed[0].message).toContain(`Change: C-1\nDecision: ${(await ctx.db.getChange("C-1"))!.decision_id}\nFollows up: ${task.id}`);
    expect(await ctx.db.getChange("C-1")).toMatchObject({ state: "pr_open", pr_url: "https://github.com/accordproject/virtual-agent-org/pull/1" });

    // Both submissions are recorded against C-1, and the follow-up's in the audit log.
    expect((await ctx.db.changeSubmissions("C-1")).map((x) => [x.task_id, x.mode, x.pr_url])).toEqual([
      [task.id, "open", "https://github.com/accordproject/virtual-agent-org/pull/1"],
      [next.id, "push", "https://github.com/accordproject/virtual-agent-org/pull/1"],
    ]);
    const row: any = await (ctx.db as any).db.prepare("SELECT detail FROM audit WHERE event_type = 'gateway.change_pr_updated'").first();
    expect(JSON.parse(row.detail)).toMatchObject({ change: "C-1", pr: "https://github.com/accordproject/virtual-agent-org/pull/1", task: next.id, commit: "pushed1" });
    const writes = await ctx.db.githubWrites("2000-01-01", "9999-12-31");
    expect(writes.at(-1)).toMatchObject({ tool: "submit_change", args: { repo: "accordproject/virtual-agent-org", number: 1, fields: ["branch", "files"] }, ok: true });

    // Once per task.
    await expect(submit(ctx, next.session_id!)).rejects.toThrow(`${next.id} has already submitted C-1`);
    expect(gh.pushed).toHaveLength(1);
    await end(ctx, fakes, next.session_id!);
    expect((await ctx.db.getTask(next.id))?.status).toBe("done");
  });

  it("a follow-up of a live change, by its decision, opens a fix-up PR from main and leaves the change live", async () => {
    const { ctx, gh, decision } = await opened();
    await ctx.db.updateChange("C-1", { state: "live", live_at: "2026-11-01 00:00:00" });
    expect(await follow(ctx, decision)).toMatch(/^Assigned T-\d+ to Mandla/);
    const next = await nextTask(ctx, decision);
    expect(next.brief).toContain("C-1 is live: its PR https://github.com/accordproject/virtual-agent-org/pull/1 is merged. Build on main");

    gh.fileReads.length = 0;
    expect(await submit(ctx, next.session_id!)).toBe("Opened https://github.com/accordproject/virtual-agent-org/pull/2, a fix-up PR for C-1. The owner reviews it; call report_status and stop.");
    expect(gh.fileReads).toEqual([{ path: "agents/mira.md", ref: "basecommit1" }]);
    expect(gh.pushed).toHaveLength(0);
    const [, fix] = gh.proposed[1];
    expect(fix.branch).toBe(`change/c-1-${next.id.toLowerCase()}`);
    expect(fix.base).toBe("basecommit1");
    expect(fix.body).toContain("Change: C-1");
    expect(fix.body).toContain("Fix-up of: https://github.com/accordproject/virtual-agent-org/pull/1");
    expect(await ctx.db.getChange("C-1")).toMatchObject({ state: "live", live_at: "2026-11-01 00:00:00", pr_url: "https://github.com/accordproject/virtual-agent-org/pull/1" });
    expect((await ctx.db.changeSubmissions("C-1")).map((x) => [x.mode, x.pr_url])).toEqual([
      ["open", "https://github.com/accordproject/virtual-agent-org/pull/1"],
      ["fix_up", "https://github.com/accordproject/virtual-agent-org/pull/2"],
    ]);
  });

  it("a follow-up that doesn't submit is blocked, and leaves the change with its PR as it is", async () => {
    const { ctx, fakes, task } = await opened();
    await follow(ctx, task.id);
    const next = await nextTask(ctx, task.id);
    await end(ctx, fakes, next.session_id!);
    expect(await ctx.db.getTask(next.id)).toMatchObject({ status: "blocked", blocked_reason: "C-1: no change submitted" });
    expect((await ctx.db.getChange("C-1"))?.state).toBe("pr_open");
  });

  it("a follow-up waits for the change's running task, and a closed change has nothing to follow up", async () => {
    const gh = fakeGitHub();
    const { ctx } = loopCtx(undefined, { dryRun: false, github: async () => gh as any });
    await decided(ctx, "mira", 10);
    const out = await propose(ctx, "mira", { ...PAYLOAD, evidence: ["D-1", "D-2"] });
    await approve(ctx, out.match(/D-\d+/)![0]);
    const task = (await ctx.db.openTasks("mandla"))[0];
    await submit(ctx, task.session_id!, { files: [{ path: "agents/mira.md", content: "x" }] });
    // Its session is still running.
    await expect(follow(ctx, task.id)).rejects.toThrow(`C-1 is pr_open and ${task.id} is running: there is nothing to follow up.`);
    await ctx.db.setTask(task.id, "done");
    for (const state of ["closed", "measured"] as const) {
      await ctx.db.updateChange("C-1", { state });
      await expect(follow(ctx, task.id)).rejects.toThrow(`C-1 is ${state}`);
    }
    expect(await ctx.db.openTasks("mandla")).toHaveLength(0);
  });

  it("a follow-up whose PR branch is gone submits nothing", async () => {
    const { ctx, gh, task } = await opened();
    delete gh.branches["change/c-1"];
    await follow(ctx, task.id);
    const next = await nextTask(ctx, task.id);
    await expect(submit(ctx, next.session_id!)).rejects.toThrow("C-1's branch change/c-1 is gone");
    expect(gh.pushed).toHaveLength(0);
    expect(await ctx.db.taskSubmission(next.id)).toBeNull();
  });

  it("GitHub.commitToBranch adds one commit on the branch's head without forcing it", async () => {
    const calls: [string, string, any][] = [];
    const R = "/repos/accordproject/virtual-agent-org";
    const fetchImpl = (async (url: string, init: any) => {
      const path = new URL(url).pathname;
      calls.push([init.method, path, init.body ? JSON.parse(init.body) : undefined]);
      if (path === `${R}/git/ref/heads/change/gone`) return new Response('{"message":"Not Found"}', { status: 404 });
      const body =
        path === `${R}/git/ref/heads/change/c-1` ? { object: { sha: "head1" } }
        : path === `${R}/git/commits/head1` ? { tree: { sha: "tree1" } }
        : path === `${R}/git/trees` ? { sha: "tree2" }
        : path === `${R}/git/commits` ? { sha: "commit2" }
        : {};
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const gh = new GitHub("t", fetchImpl);
    const r = { owner: "accordproject", repo: "virtual-agent-org" };
    const author = { name: "bot", email: "bot@example.com" };
    expect(await gh.branchHead(r, "change/c-1")).toBe("head1");
    expect(await gh.branchHead(r, "change/gone")).toBeNull();
    expect(await gh.commitToBranch(r, { branch: "change/c-1", base: "head1", files: [{ path: "a.md", content: "A" }], message: "fix: x", author })).toEqual({ sha: "commit2" });
    expect(calls.find((c) => c[0] === "POST" && c[1] === `${R}/git/commits`)?.[2]).toEqual({ message: "fix: x", tree: "tree2", parents: ["head1"], author });
    expect(calls.find((c) => c[0] === "PATCH")).toEqual(["PATCH", `${R}/git/refs/heads/change/c-1`, { sha: "commit2", force: false }]);
    expect(calls.some((c) => c[1] === `${R}/pulls`)).toBe(false);
  });
});

describe("measuring changes", () => {
  const sql = (ctx: Ctx, q: string, ...args: unknown[]) => (ctx.db as any).db.prepare(q).bind(...args).run();
  const w = (value: number | null, cases = 10) => ({ value, cases });

  /** A decision for `agent` decided with `status` at `at` (D1 time). */
  async function decidedOn(ctx: Ctx, agent: string, at: string, status: string, kind = "github.comment") {
    const d = await ctx.db.createDecision({ agent, kind, target: "accordproject/concerto#1", summary: "s", rationale: "r", risk: "low" });
    await sql(ctx, "UPDATE decisions SET status = ?, decided_at = ? WHERE id = ?", status, at, d.id);
  }
  /** A change in `state` with its own timestamps. */
  async function change(ctx: Ctx, agent: string, fields: Record<string, unknown>, measure = "approval_rate") {
    const c = await ctx.db.createChange({ agent, decision_id: "D-99", change_type: "wording", measure, kinds: ["github.comment"] });
    await ctx.db.updateChange(c.id, fields);
    return c.id;
  }

  it("verdictFor compares rates by 0.05 and cost by 15%", () => {
    const cases: [string, ReturnType<typeof w>, ReturnType<typeof w>, string][] = [
      ["approval_rate", w(0.5), w(0.55), "better"],
      ["approval_rate", w(0.5), w(0.54), "same"],
      ["approval_rate", w(0.5), w(0.45), "worse"],
      ["approval_rate", w(0.5), w(0.46), "same"],
      ["repeat_rejections", w(0.5), w(0.45), "better"],
      ["repeat_rejections", w(0.5), w(0.55), "worse"],
      ["repeat_rejections", w(0.5), w(0.52), "same"],
      ["tool_refusals", w(0.2), w(0.1), "better"],
      ["tool_refusals", w(0.1), w(0.2), "worse"],
      ["cost_per_approval", w(100), w(85), "better"],
      ["cost_per_approval", w(100), w(86), "same"],
      ["cost_per_approval", w(100), w(115), "worse"],
      ["cost_per_approval", w(100), w(114), "same"],
      ["approval_rate", w(0.5, 4), w(0.9), "too_little_data"],
      ["approval_rate", w(0.5), w(0.9, 4), "too_little_data"],
      ["tool_refusals", w(null, 0), w(0.1), "too_little_data"],
    ];
    for (const [m, b, a, v] of cases) expect([m, b.value, a.value, verdictFor(m, b, a)]).toEqual([m, b.value, a.value, v]);
    // Cheaper is worse if fewer decisions are approved.
    expect(verdictFor("cost_per_approval", w(100), w(80), { before: w(0.6), after: w(0.55) })).toBe("worse");
    expect(verdictFor("cost_per_approval", w(100), w(80), { before: w(0.6), after: w(0.56) })).toBe("better");
  });

  it("tickChanges measures a change 14 days after it went live", async () => {
    const { ctx } = loopCtx();
    const id = await change(ctx, "mira", { state: "live", live_at: "2026-10-01 00:00:00" });
    for (let i = 0; i < 6; i++) await decidedOn(ctx, "mira", "2026-09-20 10:00:00", i < 3 ? "approved" : "rejected");
    for (let i = 0; i < 6; i++) await decidedOn(ctx, "mira", "2026-10-05 10:00:00", i < 5 ? "executed" : "rejected");
    // Not counted: other agents, tool confirmations, and anything outside the windows.
    await decidedOn(ctx, "vera", "2026-10-05 10:00:00", "rejected");
    await decidedOn(ctx, "mira", "2026-10-05 10:00:00", "rejected", "tool.confirm");
    await decidedOn(ctx, "mira", "2026-09-10 10:00:00", "rejected");

    await tickChanges(ctx, new Date("2026-10-14T23:00:00Z"));
    expect((await ctx.db.getChange(id))?.state).toBe("live");
    await tickChanges(ctx, new Date("2026-10-15T00:00:01Z"));
    const c = (await ctx.db.getChange(id))!;
    expect(c).toMatchObject({ state: "measured", before: 0.5, before_cases: 6, after_cases: 6, verdict: "better", measured_at: "2026-10-15 00:00:01" });
    expect(c.after).toBeCloseTo(5 / 6);
    expect(JSON.parse(c.overlaps!)).toEqual([]);
  });

  it("measures refused calls to a tool and cost per approval", async () => {
    const { ctx } = loopCtx();
    const tool = await change(ctx, "mira", { state: "live", live_at: "2026-10-01 00:00:00", tool: "request_action" }, "tool_refusals");
    const cost = await change(ctx, "vera", { state: "live", live_at: "2026-10-01 00:00:00" }, "cost_per_approval");
    const call = (at: string, event_type: string, t = "request_action") =>
      sql(ctx, "INSERT INTO audit (ts, agent, event_type, tool) VALUES (?, 'mira', ?, ?)", at, event_type, t);
    for (let i = 0; i < 5; i++) await call("2026-09-25 10:00:00", "agent.custom_tool_use");
    await call("2026-09-25 10:00:00", "gateway.tool_refused");
    await call("2026-09-25 10:00:00", "gateway.tool_denied");
    await call("2026-09-25 10:00:00", "gateway.tool_refused", "label_pr");
    for (let i = 0; i < 5; i++) await call("2026-10-03 10:00:00", "agent.custom_tool_use");

    for (let i = 0; i < 5; i++) await decidedOn(ctx, "vera", "2026-09-25 10:00:00", "approved");
    for (let i = 0; i < 5; i++) await decidedOn(ctx, "vera", "2026-10-03 10:00:00", "approved");
    await sql(ctx, "INSERT INTO sessions (id, agent, origin, cost_cents, created_at) VALUES ('s1', 'vera', 'task', 500, '2026-09-25 09:00:00')");
    await sql(ctx, "INSERT INTO sessions (id, agent, origin, cost_cents, created_at) VALUES ('s2', 'vera', 'task', 300, '2026-10-03 09:00:00')");

    await tickChanges(ctx, new Date("2026-10-16T00:00:00Z"));
    expect(await ctx.db.getChange(tool)).toMatchObject({ state: "measured", before: 0.4, after: 0, before_cases: 5, after_cases: 5, verdict: "better" });
    expect(await ctx.db.getChange(cost)).toMatchObject({ state: "measured", before: 100, after: 60, before_cases: 5, after_cases: 5, verdict: "better" });
  });

  it("too little data stays live, is tried again weekly, then closes", async () => {
    const { ctx } = loopCtx();
    const id = await change(ctx, "mira", { state: "live", live_at: "2026-10-01 00:00:00" });
    for (let i = 0; i < 2; i++) await decidedOn(ctx, "mira", "2026-09-25 10:00:00", "approved");
    await tickChanges(ctx, new Date("2026-10-15T01:00:00Z"));
    expect(await ctx.db.getChange(id)).toMatchObject({ state: "live", verdict: "too_little_data", before_cases: 2, after_cases: 0, measured_at: "2026-10-15 01:00:00" });
    await tickChanges(ctx, new Date("2026-10-21T01:00:00Z"));
    expect((await ctx.db.getChange(id))?.measured_at).toBe("2026-10-15 01:00:00");
    await tickChanges(ctx, new Date("2026-10-22T01:00:00Z"));
    expect(await ctx.db.getChange(id)).toMatchObject({ state: "live", measured_at: "2026-10-22 01:00:00" });
    await tickChanges(ctx, new Date("2026-11-12T01:00:00Z"));
    expect(await ctx.db.getChange(id)).toMatchObject({ state: "closed", closed_reason: "too little data", verdict: "too_little_data" });
  });

  it("a stale PR closes its change after 30 days", async () => {
    const { ctx } = loopCtx();
    const id = await change(ctx, "mira", { state: "pr_open", pr_opened_at: "2026-09-01 00:00:00", pr_url: "https://github.com/x/y/pull/1" });
    await tickChanges(ctx, new Date("2026-09-30T23:00:00Z"));
    expect((await ctx.db.getChange(id))?.state).toBe("pr_open");
    await tickChanges(ctx, new Date("2026-10-01T00:00:01Z"));
    expect(await ctx.db.getChange(id)).toMatchObject({ state: "closed", closed_reason: "stale" });
  });

  it("a change still building after 7 days is closed", async () => {
    const { ctx } = loopCtx();
    const stuck = await change(ctx, "mira", {});
    const recent = await change(ctx, "mira", {});
    await sql(ctx, "UPDATE changes SET created_at = ? WHERE id = ?", "2026-10-01 00:00:00", stuck);
    await sql(ctx, "UPDATE changes SET created_at = ? WHERE id = ?", "2026-10-02 00:00:00", recent);
    await tickChanges(ctx, new Date("2026-10-07T23:00:00Z"));
    expect((await ctx.db.getChange(stuck))?.state).toBe("building");
    await tickChanges(ctx, new Date("2026-10-08T00:00:01Z"));
    expect(await ctx.db.getChange(stuck)).toMatchObject({ state: "closed", closed_reason: "stuck building" });
    expect((await ctx.db.getChange(recent))?.state).toBe("building");
    const audit = await (ctx.db as any).db.prepare("SELECT detail FROM audit WHERE event_type = 'gateway.change_closed'").all();
    expect(audit.results.map((r: any) => JSON.parse(r.detail))).toEqual([{ change: stuck, reason: "stuck building" }]);
  });

  it("one stale close failing doesn't stop the others", async () => {
    const { ctx } = loopCtx();
    const a = await change(ctx, "mira", { state: "pr_open", pr_opened_at: "2026-09-01 00:00:00" });
    const b = await change(ctx, "mira", { state: "pr_open", pr_opened_at: "2026-09-01 00:00:00" });
    const update = ctx.db.updateChange.bind(ctx.db);
    (ctx.db as any).updateChange = async (id: string, f: any) => {
      if (id === a) throw new Error("D1 hiccup");
      return update(id, f);
    };
    await tickChanges(ctx, new Date("2026-10-15T00:00:00Z"));
    expect(await ctx.db.getChange(b)).toMatchObject({ state: "closed", closed_reason: "stale" });
    const rows = await (ctx.db as any).db.prepare("SELECT detail FROM audit WHERE event_type = 'gateway.changes_error'").all();
    expect(JSON.parse(rows.results[0].detail)).toEqual({ change: a, error: "D1 hiccup" });
  });

  it("changes to the network overlap every agent's", async () => {
    const { ctx } = loopCtx();
    const mira = await change(ctx, "mira", { state: "live", live_at: "2026-10-01 00:00:00" });
    const net = await change(ctx, "network", { state: "live", live_at: "2026-10-05 00:00:00" });
    const vera = await change(ctx, "vera", { state: "live", live_at: "2026-10-08 00:00:00" });
    await tickChanges(ctx, new Date("2026-10-25T00:00:00Z"));
    expect(JSON.parse((await ctx.db.getChange(mira))!.overlaps!)).toEqual([net]);
    expect(JSON.parse((await ctx.db.getChange(net))!.overlaps!)).toEqual([mira, vera]);
    expect(JSON.parse((await ctx.db.getChange(vera))!.overlaps!)).toEqual([net]);
  });

  it("overlapping changes name each other", async () => {
    const { ctx } = loopCtx();
    const a = await change(ctx, "mira", { state: "live", live_at: "2026-10-01 00:00:00" });
    const b = await change(ctx, "mira", { state: "live", live_at: "2026-10-10 00:00:00" });
    const later = await change(ctx, "mira", { state: "live", live_at: "2026-11-01 00:00:00" });
    await change(ctx, "vera", { state: "live", live_at: "2026-10-05 00:00:00" });
    await tickChanges(ctx, new Date("2026-10-25T00:00:00Z"));
    expect(JSON.parse((await ctx.db.getChange(a))!.overlaps!)).toEqual([b]);
    expect(JSON.parse((await ctx.db.getChange(b))!.overlaps!)).toEqual([a]);
    expect((await ctx.db.getChange(later))?.state).toBe("live");
  });

  it("tickChanges never throws", async () => {
    const { ctx } = loopCtx();
    await change(ctx, "mira", { state: "live", live_at: "2026-10-01 00:00:00" });
    (ctx.db as any).measureWindow = async () => {
      throw new Error("D1 down");
    };
    await expect(tickChanges(ctx, new Date("2026-10-20T00:00:00Z"))).resolves.toBeUndefined();
    const rows = await (ctx.db as any).db.prepare("SELECT detail FROM audit WHERE event_type = 'gateway.changes_error'").all();
    expect(rows.results[0].detail).toContain("D1 down");
  });

  it("get_status shows open and recent changes", async () => {
    const { ctx } = loopCtx();
    const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString().slice(0, 19).replace("T", " ");
    const building = await change(ctx, "mira", {});
    const recent = await change(ctx, "mira", { state: "measured", measured_at: ago(3), before: 0.5, after: 0.6, verdict: "better", overlaps: "[]" });
    await change(ctx, "mira", { state: "measured", measured_at: ago(20), verdict: "same", overlaps: "[]" });
    const closed = await change(ctx, "vera", { state: "closed", closed_reason: "stale" });
    const old = await change(ctx, "vera", { state: "closed", closed_reason: "stale" });
    await sql(ctx, "UPDATE changes SET updated_at = ? WHERE id = ?", ago(30), old);

    const st = JSON.parse(await handleTool(ctx, "ada", "sesn_x", "get_status", {}));
    expect(st.changes.map((c: any) => c.id)).toEqual([building, recent, closed]);
    expect(st.changes[1]).toMatchObject({ agent: "mira", type: "wording", state: "measured", verdict: "better", before: 0.5, after: 0.6, overlaps: [] });
    const mira = JSON.parse(await handleTool(ctx, "ada", "sesn_x", "get_status", { agent: "mira" }));
    expect(mira.changes.map((c: any) => c.id)).toEqual([building, recent]);
  });

  it("read_audit lists changes measured in its period, and /status lists open ones", async () => {
    const { ctx } = loopCtx();
    await change(ctx, "mira", { state: "measured", measured_at: "2026-10-15 00:00:00", verdict: "better", overlaps: "[]" });
    await change(ctx, "mira", { state: "measured", measured_at: "2026-09-15 00:00:00", verdict: "worse", overlaps: "[]" });
    await change(ctx, "vera", { state: "pr_open", pr_url: "https://github.com/accordproject/virtual-agent-org/pull/9" });
    await change(ctx, "network", { state: "live" });
    const out = JSON.parse(await handleTool(ctx, "vera", "sesn_v", "read_audit", { since: "2026-10-01", until: "2026-10-31" }));
    expect(out.changes.map((c: any) => [c.id, c.verdict])).toEqual([["C-1", "better"]]);
    const st = await gatherStatus(ctx);
    const plain = statusPlain(st);
    expect(plain).toContain("Changes in flight:\n  C-3 Vera · pr_open · https://github.com/accordproject/virtual-agent-org/pull/9\n  C-4 Network · live");
    const cards = statusCards(st).content;
    expect(cards).toContain("2 changes in flight");
    expect(cards).toContain("- C-3 · Vera · pr_open · https://github.com/accordproject/virtual-agent-org/pull/9");
    expect(cards).toContain("- C-4 · Network · live");
  });

  it("read_audit lists blocked reports and dismissed findings in its period", async () => {
    const { ctx } = loopCtx();
    await ctx.db.addStatus({ agent: "mira", session_id: "s1", done: [], doing: [], blocked: ["No CI on concerto#5"] });
    await ctx.db.addStatus({ agent: "otto", session_id: "s2", done: ["x"], doing: [], blocked: [] });
    await ctx.db.addStatus({ agent: "mira", session_id: "s3", done: [], doing: [], blocked: ["Old"] });
    await sql(ctx, "UPDATE statuses SET created_at = ?", "2026-10-10 09:00:00");
    await sql(ctx, "UPDATE statuses SET created_at = ? WHERE id = 3", "2026-09-10 09:00:00");
    const finding = (id: string, outcome: string | null, at: string | null) =>
      sql(
        ctx,
        "INSERT INTO review_findings (id, seq, review_id, target, severity, area, summary, outcome, outcome_note, outcome_at) VALUES (?, 1, 'R-1', 'accordproject/concerto#5', 'nit', 'style', 'Rename x', ?, 'Not our style', ?)",
        id, outcome, at,
      );
    await finding("F-1", "dismissed", "2026-10-12 10:00:00");
    await finding("F-2", "acted", "2026-10-12 10:00:00");
    await finding("F-3", "dismissed", "2026-09-12 10:00:00");
    await finding("F-4", null, null);
    const out = JSON.parse(await handleTool(ctx, "vera", "sesn_v", "read_audit", { since: "2026-10-01", until: "2026-10-31" }));
    expect(out.blocked_reports).toEqual([{ id: "status:1", agent: "mira", blockers: ["No CI on concerto#5"], created_at: "2026-10-10 09:00:00" }]);
    expect(out.dismissed_findings).toEqual([
      { id: "F-1", target: "accordproject/concerto#5", area: "style", summary: "Rename x", outcome_note: "Not our style" },
    ]);
  });
});
