import { describe, expect, it } from "vitest";
import { ActionInvalid, validateAction } from "../src/actions";
import { changeBrief } from "../src/changes";
import type { Ctx } from "../src/context";
import { approve } from "../src/controls";
import { GitHub } from "../src/github";
import { handleTool, ToolDenied, ToolError } from "../src/tools";
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
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A test network with the loop switched on at `since`, and the mechanic deployed. */
function loopCtx(since: string | null = isoDay(Date.now() - 30 * DAY), overrides: Partial<Ctx> = {}) {
  return makeTestCtx({
    ...overrides,
    network: { ...NETWORK, self_improvement: { ...NETWORK.self_improvement!, since } },
    deployed: {
      ...DEPLOYED,
      agents: { ...DEPLOYED.agents, mechanic: { agent_id: "agent_mechanic", environment_id: "env_1", vault_ids: [], memory_store_ids: ["mem_mechanic"], session_budget_cents: 100 } },
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
      ["mechanic", "wording", "high"],
    ];
    for (const [target, change_type, risk] of cases) {
      const out = await propose(ctx, target, { ...PAYLOAD, change_type });
      const id = out.match(/D-\d+/)![0];
      expect((await ctx.db.getDecision(id))?.risk, `${target} ${change_type}`).toBe(risk);
    }
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

  it("approving spec.change starts a mechanic task", async () => {
    const { ctx, fakes } = loopCtx();
    await decided(ctx, "mira", 10);
    await ctx.db.createDecision({ agent: "mira", kind: "github.review", target: "accordproject/concerto#1", summary: "s", rationale: "r", risk: "low" });
    const out = await propose(ctx, "mira", { ...PAYLOAD, evidence: ["D-1", "D-2", "D-11"] });
    const id = out.match(/D-\d+/)![0];

    const reply = await approve(ctx, id);
    const change = (await ctx.db.getChange("C-1"))!;
    expect(change).toMatchObject({ agent: "mira", decision_id: id, change_type: "wording", measure: "approval_rate", state: "building" });
    expect(JSON.parse(change.kinds)).toEqual(["github.comment", "github.review"]);
    const task = (await ctx.db.openTasks("mechanic"))[0];
    expect(task).toMatchObject({ id: change.task_id, kind: "change", status: "running" });
    const sessions = fakes.calls.filter((c) => c.method === "createSession").map((c) => c.args[0] as any);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ agentId: "agent_mechanic", budgetCents: 100 });
    expect(sessions[0].model).toBeUndefined();
    expect(sessions[0].text).toContain("C-1");
    const d = (await ctx.db.getDecision(id))!;
    expect(d.status).toBe("executed");
    expect(d.result).toContain("C-1");
    expect(d.result).toContain(task.id);
    expect(reply).toContain("C-1");

    const tool = await propose(ctx, "mira", { ...PAYLOAD, change_type: "tool" });
    await approve(ctx, tool.match(/D-\d+/)![0]);
    const second = fakes.calls.filter((c) => c.method === "createSession").map((c) => c.args[0] as any)[1];
    expect(second).toMatchObject({ budgetCents: 500, model: NETWORK.model_tiers!.deep });
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
    expect(brief).toContain("Change only what the decision approved. Don't change files under .github/ or gateway/src/generated/ by hand; run npm run compile if config changed. Never weaken a test. Submit once with submit_change, then report_status.");
  });
});

describe("submit_change", () => {
  /** An approved wording change to Mira, C-1, with the mechanic's task running. */
  async function building(dryRun = false) {
    const gh = fakeGitHub();
    const { ctx, fakes } = loopCtx(undefined, { dryRun, github: async () => gh as any });
    await decided(ctx, "mira", 10);
    const out = await propose(ctx, "mira", { ...PAYLOAD, evidence: ["D-1", "D-2"] });
    const decision = out.match(/D-\d+/)![0];
    await approve(ctx, decision);
    const task = (await ctx.db.openTasks("mechanic"))[0];
    return { ctx, fakes, gh, decision, session: task.session_id! };
  }

  const INPUT = {
    change: "C-1",
    title: "docs(mira): thank the contributor first",
    body: "Adds a line to step 3 of Mira's spec.",
    files: [{ path: "agents/mira.md", content: "# Mira\n" }],
  };
  const submit = (ctx: Ctx, session: string, input: object = {}, agent = "mechanic") =>
    handleTool(ctx, agent, session, "submit_change", { ...INPUT, ...input });

  it("only the mechanic's change task may submit", async () => {
    const { ctx, session } = await building();
    await expect(submit(ctx, session, {}, "mira")).rejects.toBeInstanceOf(ToolDenied);
    await ctx.db.upsertSession({ id: "sesn_other", agent: "mechanic", origin: "task", started_by: "owner" });
    await expect(submit(ctx, "sesn_other")).rejects.toThrow("Only a mechanic task started for an approved change can submit");
    await expect(submit(ctx, session, { change: "C-2" })).rejects.toThrow("This task is for C-1, not C-2");
  });

  it("submit_change refuses unsafe paths before calling GitHub", async () => {
    const { ctx, session, gh } = await building();
    const bad = [".github/workflows/ci.yml", "../x", "/etc/x", "gateway/src/generated/network.json", "", "agents\\mira.md"];
    const files = [...bad.map((path) => ({ path, content: "x" })), { path: "a.md", content: "x" }, { path: "a.md", delete: true }, { path: "b.md" }, { path: "c.md", content: "x", delete: true }];
    const err = await submit(ctx, session, { files }).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    for (const p of [...bad.slice(0, 4), "files[4] has an empty path", "agents\\mira.md: use /", "a.md more than once", "b.md: give exactly one", "c.md: give exactly one"]) expect(err.message).toContain(p);
    expect(gh.proposed).toHaveLength(0);
    expect((await ctx.db.getChange("C-1"))?.state).toBe("building");
  });

  it("submit_change checks the title and body", async () => {
    const { ctx, session } = await building();
    await expect(submit(ctx, session, { title: "Thank contributors" })).rejects.toThrow(/Conventional Commits/);
    await expect(submit(ctx, session, { title: `docs: ${"x".repeat(100)}` })).rejects.toThrow(/100/);
    await expect(submit(ctx, session, { body: "x".repeat(20_001) })).rejects.toThrow(/20,000/);
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
    for (const s of [decision, "D-1, D-2", "approval_rate", "Built by the mechanic; needs the owner's review like any other PR.", "## Change", INPUT.body]) expect(p.body).toContain(s);
    expect(p.body.split("\n")).toContain("Change: C-1");

    const change = (await ctx.db.getChange("C-1"))!;
    expect(change).toMatchObject({ state: "pr_open", pr_url: "https://github.com/accordproject/virtual-agent-org/pull/1" });
    expect(change.pr_opened_at).toBeTruthy();
    const audit = await (ctx.db as any).db.prepare("SELECT agent, detail FROM audit WHERE event_type = 'gateway.change_pr_opened'").all();
    expect(audit.results).toHaveLength(1);
    expect(JSON.parse(audit.results[0].detail)).toEqual({ change: "C-1", decision, pr: change.pr_url });
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
  });

  it("dry run doesn't open a PR", async () => {
    const { ctx, session, gh } = await building(true);
    expect(await submit(ctx, session)).toMatch(/^DRY RUN: would open a PR for C-1/);
    expect(gh.proposed).toHaveLength(0);
    expect((await ctx.db.getChange("C-1"))?.state).toBe("building");
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
});
