import { describe, expect, it } from "vitest";
import { startSession } from "../src/agents";
import { tickChanges } from "../src/changes";
import { syncPrHistory } from "../src/community";
import { Db } from "../src/db";
import { dailyCheck, dispatchWakes, triageCheck } from "../src/githubEvents";
import { cronMatches, localTime, parseCron } from "../src/cron";
import { CATCH_UP_MINUTES, runSchedules } from "../src/schedules";
import { housekeeping, processSession, sweep } from "../src/sessions";
import { DEPLOYED, NETWORK, fakeGitHub, makeTestCtx, memoryD1 } from "./helpers";

describe("session processing", () => {
  it("answers custom tools once, queues ask-permission calls, and forwards Telegram replies", async () => {
    const { ctx, fakes } = makeTestCtx();
    fakes.sessions.sesn_t = { id: "sesn_t", status: "idle", agent: { id: "agent_mira" }, stop_reason: { type: "requires_action" } };
    await ctx.db.upsertSession({ id: "sesn_t", agent: "mira", origin: "telegram", chat_id: 42 });
    fakes.events.sesn_t = [
      { id: "e1", type: "agent.message", content: [{ type: "text", text: "On it." }] },
      { id: "e2", type: "agent.custom_tool_use", name: "report_status", input: { done: ["a"], doing: [], blocked: [] } },
      { id: "e3", type: "agent.mcp_tool_use", name: "mcp__github__merge", evaluated_permission: "ask", input: {} },
    ];
    await processSession(ctx, "sesn_t");
    await processSession(ctx, "sesn_t"); // idempotent

    expect(fakes.calls.filter((c) => c.method === "sendToolResult")).toHaveLength(1);
    expect(fakes.sent.filter((s) => s.text === "Mira: On it.")).toHaveLength(1);
    const open = await ctx.db.listDecisions({ status: "open" });
    expect(open.map((d) => d.kind)).toEqual(["tool.confirm"]);
    expect((await ctx.db.latestStatuses("mira"))[0].done).toEqual(["a"]);
  });

  it("returns tool errors to the agent instead of failing", async () => {
    const { ctx, fakes } = makeTestCtx();
    fakes.sessions.s2 = { id: "s2", status: "idle", agent: "agent_mira", stop_reason: { type: "requires_action" } };
    fakes.events.s2 = [{ id: "e1", type: "agent.custom_tool_use", name: "send_to_matt", input: { text: "x" } }];
    await processSession(ctx, "s2");
    const r = fakes.calls.find((c) => c.method === "sendToolResult")!;
    expect(r.args[2]).toMatch(/^Error: send_to_matt is not available to mira/);
    // Refusals on permission grounds are logged as denials (decision 48).
    const denied = await (ctx.db as any).db.prepare("SELECT tool, permission FROM audit WHERE event_type = 'gateway.tool_denied'").all();
    expect(denied.results).toEqual([{ tool: "send_to_matt", permission: "deny" }]);
  });

  it("a tool call refused for bad input is audited as gateway.tool_refused", async () => {
    const { ctx, fakes } = makeTestCtx();
    fakes.sessions.s5 = { id: "s5", status: "idle", agent: "agent_mira", stop_reason: { type: "requires_action" } };
    fakes.events.s5 = [{ id: "e1", type: "agent.custom_tool_use", name: "request_action", input: {} }];
    await processSession(ctx, "s5");
    const r = fakes.calls.find((c) => c.method === "sendToolResult")!;
    expect(r.args[2]).toMatch(/^Error: /);
    const rows = await (ctx.db as any).db.prepare("SELECT tool, detail FROM audit WHERE event_type = 'gateway.tool_refused'").all();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].tool).toBe("request_action");
    expect(rows.results[0].detail).toContain("kind is required");
  });

  it("records a scheduled session's tokens and default model, and never lowers them", async () => {
    const { ctx, fakes } = makeTestCtx();
    const usage = { list_cost: { amount: "42", currency: "USD" }, input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 9000, cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 10 } };
    fakes.sessions.s4 = { id: "s4", status: "running", agent: { id: "agent_mira" }, usage };
    await processSession(ctx, "s4");
    expect(await ctx.db.getSession("s4")).toMatchObject({
      origin: "deployment", model: "claude-sonnet-5-5", cost_cents: 42, input_tokens: 1200, output_tokens: 300, cache_read_tokens: 9000, cache_write_tokens: 50,
    });
    fakes.sessions.s4 = { id: "s4", status: "idle", agent: { id: "agent_mira" }, stop_reason: { type: "end_turn" }, usage: { input_tokens: 10 } };
    await processSession(ctx, "s4");
    expect(await ctx.db.getSession("s4")).toMatchObject({ cost_cents: 42, input_tokens: 1200, status: "idle:end_turn" });
  });

  it("reads an idle session's stop reason from its latest idle event, so a finished session leaves the sweep", async () => {
    const { ctx, fakes } = makeTestCtx();
    await ctx.db.upsertSession({ id: "sx", agent: "mira", origin: "task" });
    // As the live API returns it: no stop_reason on the session object.
    fakes.sessions.sx = { id: "sx", status: "idle", agent: { id: "agent_mira" } };
    fakes.events.sx = [
      { id: "i1", type: "session.status_idle", stop_reason: { type: "requires_action" } },
      { id: "r1", type: "session.status_running" },
      { id: "i2", type: "session.status_idle", stop_reason: { type: "end_turn" } },
    ];
    await processSession(ctx, "sx");
    expect((await ctx.db.getSession("sx"))?.status).toBe("idle:end_turn");
    expect((await ctx.db.sweepableSessions(10)).map((s) => s.id)).not.toContain("sx");
  });

  it("records the model a scheduled run on a task reports, not the agent's default", async () => {
    const { ctx, fakes } = makeTestCtx();
    fakes.sessions.s5 = { id: "s5", status: "running", agent: { id: "agent_mira", model: { id: "claude-haiku-5-5", effort: "medium" } } };
    await processSession(ctx, "s5");
    expect((await ctx.db.getSession("s5"))?.model).toBe("claude-haiku-5-5");
    fakes.sessions.s6 = { id: "s6", status: "running", agent: { id: "agent_mira", model: "claude-opus-5-5" } };
    await processSession(ctx, "s6");
    expect((await ctx.db.getSession("s6"))?.model).toBe("claude-opus-5-5");
  });

  it("reads cache writes from either usage shape", async () => {
    const { sessionTokens } = await import("../src/managed");
    const base = { id: "s", status: "idle" as const };
    expect(sessionTokens({ ...base, usage: { cache_creation: { ephemeral_5m_input_tokens: 68773, ephemeral_1h_input_tokens: 0 } } }).cache_write_tokens).toBe(68773);
    expect(sessionTokens({ ...base, usage: { cache_creation_input_tokens: 50 } }).cache_write_tokens).toBe(50);
    expect(sessionTokens({ ...base, usage: {} }).cache_write_tokens).toBe(0);
  });
});

describe("sessions that are waiting", () => {
  it("starts a fresh session when the last one is paused on a tool call", async () => {
    const { ManagedAgentsError } = await import("../src/managed");
    const { messageAgent } = await import("../src/agents");
    const { ctx, fakes } = makeTestCtx();
    const first = await messageAgent(ctx, "ada", { discord: "111111111111111111" }, "hello", "owner");
    (ctx.managed as any).sendMessage = async () => {
      throw new ManagedAgentsError(400, '{"error":{"message":"Invalid user.message event at events[0]: waiting on responses to events [sevt_1]"}}', "/sessions/x/events");
    };
    const second = await messageAgent(ctx, "ada", { discord: "111111111111111111" }, "are you there?", "owner");
    expect(second).not.toBe(first);
    expect(fakes.calls.filter((c) => c.method === "createSession")).toHaveLength(2);
    // and the next message continues the new session, not the paused one
    (ctx.managed as any).sendMessage = async (id: string) => fakes.calls.push({ method: "sendMessage", args: [id] });
    await messageAgent(ctx, "ada", { discord: "111111111111111111" }, "thanks", "owner");
    expect(fakes.calls.at(-1)).toEqual({ method: "sendMessage", args: [second] });
  });

  it("does not hide other errors when continuing a session", async () => {
    const { ManagedAgentsError } = await import("../src/managed");
    const { messageAgent } = await import("../src/agents");
    const { ctx } = makeTestCtx();
    await messageAgent(ctx, "ada", { telegram: 42 }, "hello", "owner");
    (ctx.managed as any).sendMessage = async () => {
      throw new ManagedAgentsError(500, "boom", "/sessions/x/events");
    };
    await expect(messageAgent(ctx, "ada", { telegram: 42 }, "again", "owner")).rejects.toThrow(/500/);
  });

  it("answers a tool call even when the gateway fails unexpectedly", async () => {
    const { ctx, fakes } = makeTestCtx();
    ctx.tg = { ...ctx.tg, send: async () => { throw new Error("Telegram down"); } } as any;
    fakes.sessions.s3 = { id: "s3", status: "idle", agent: "agent_ada", stop_reason: { type: "requires_action" } };
    fakes.events.s3 = [{ id: "e1", type: "agent.custom_tool_use", name: "send_to_matt", input: { text: "check-in" } }];
    await processSession(ctx, "s3");
    const r = fakes.calls.find((c) => c.method === "sendToolResult")!;
    expect(r.args[1]).toBe("e1");
    expect(r.args[2]).toMatch(/^Error: the gateway could not run send_to_matt: Telegram down/);
  });
});

describe("sessions out of budget", () => {
  it("starts fresh when the session has spent its budget", async () => {
    const { ManagedAgentsError } = await import("../src/managed");
    const { messageAgent } = await import("../src/agents");
    const { ctx, fakes } = makeTestCtx();
    const first = await messageAgent(ctx, "ada", { discord: "111111111111111111" }, "hello", "owner");
    (ctx.managed as any).sendMessage = async () => {
      throw new ManagedAgentsError(400, '{"error":{"message":"session budget reached: consumed list cost has met `budget.max_list_cost`"}}', "/sessions/x/events");
    };
    const second = await messageAgent(ctx, "ada", { discord: "111111111111111111" }, "still there?", "owner");
    expect(second).not.toBe(first);
    expect(fakes.calls.filter((c) => c.method === "createSession")).toHaveLength(2);
  });

  it("doesn't continue a conversation that has used most of its budget, or one known to be spent", async () => {
    const { messageAgent } = await import("../src/agents");
    const { ctx, fakes } = makeTestCtx(); // Ada's session budget in the fixture is 150 cents
    const first = await messageAgent(ctx, "ada", { telegram: 42 }, "hello", "owner");
    await ctx.db.updateSession(first, "idle:end_turn", 125); // 83% spent
    const second = await messageAgent(ctx, "ada", { telegram: 42 }, "next", "owner");
    expect(second).not.toBe(first);
    await ctx.db.updateSession(second, "idle:budget_reached", 10);
    const third = await messageAgent(ctx, "ada", { telegram: 42 }, "and again", "owner");
    expect(third).not.toBe(second);
    expect(fakes.calls.filter((c) => c.method === "sendMessage")).toHaveLength(0);
  });
});

describe("shared memory upsert", () => {
  it("updates the existing memory when the path is already taken", async () => {
    const { ManagedClient } = await import("../src/managed");
    const calls: { method: string; url: string; body: any; beta: string }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ method: String(init.method), url, body, beta: (init.headers as any)["anthropic-beta"] });
      if (calls.length === 1) {
        return new Response(
          JSON.stringify({
            type: "error",
            error: { type: "memory_path_conflict_error", conflicting_path: "/context/accord.md", conflicting_memory_id: "mem_1" },
          }),
          { status: 409 },
        );
      }
      return new Response(JSON.stringify({ id: "mem_1" }));
    }) as unknown as typeof fetch;
    const r = await new ManagedClient("k", fake).upsertMemory("memstore_9", "/context/accord.md", "new text");
    expect(r).toEqual({ id: "mem_1", updated: true });
    expect(calls[1].url).toBe("https://api.anthropic.com/v1/memory_stores/memstore_9/memories/mem_1");
    expect(calls[1].body).toEqual({ content: "new text" });
    expect(calls.every((c) => c.beta === "agent-memory-2026-07-22")).toBe(true);
  });

  it("does not swallow other errors", async () => {
    const { ManagedClient } = await import("../src/managed");
    const fake = (async () => new Response('{"error":{"type":"permission_error"}}', { status: 403 })) as unknown as typeof fetch;
    await expect(new ManagedClient("k", fake).upsertMemory("s", "/p", "x")).rejects.toThrow(/403/);
  });
});

describe("following up blocked tasks (decision 50)", () => {
  const audit = async (ctx: any, type: string) =>
    (await ctx.db.db.prepare("SELECT detail FROM audit WHERE event_type = ? ORDER BY id").bind(type).all()).results.map((r: any) => JSON.parse(r.detail));
  const adaWakes = (fakes: any) => fakes.calls.filter((c: any) => c.method === "createSession" && c.args[0].agentId === "agent_ada");

  /** A task for an agent whose session ends its turn after reporting `blocked` (or not reporting, for null). */
  async function finish(ctx: any, fakes: any, blocked: string[] | null, o: { agent?: string; sid?: string; follows_up?: string } = {}) {
    const agent = o.agent ?? "mira";
    const sid = o.sid ?? `sesn_${agent}_task`;
    const task = await ctx.db.createTask({ agent, title: "Chase the parser PRs", brief: "b", ...(o.follows_up ? { follows_up: o.follows_up } : {}) });
    await ctx.db.upsertSession({ id: sid, agent, origin: "task", task_id: task.id, started_by: "owner" });
    await ctx.db.setTask(task.id, "running", sid);
    fakes.sessions[sid] = { id: sid, status: "idle", agent: { id: `agent_${agent}` }, stop_reason: { type: "end_turn" } };
    fakes.events[sid] = blocked
      ? [{ id: `${sid}_e1`, type: "agent.custom_tool_use", name: "report_status", input: { done: [], doing: [], blocked } }]
      : [];
    await processSession(ctx, sid);
    return task.id as string;
  }

  it("marks a task done when its last report lists no blockers, and doesn't wake Ada", async () => {
    const { ctx, fakes } = makeTestCtx();
    const id = await finish(ctx, fakes, []);
    expect((await ctx.db.getTask(id))?.status).toBe("done");
    const silent = await finish(ctx, fakes, null, { sid: "sesn_silent" });
    expect((await ctx.db.getTask(silent))?.status).toBe("done");
    expect(adaWakes(fakes)).toHaveLength(0);
  });

  it("marks a task blocked when its last report lists blockers, keeps it open, and wakes Ada once", async () => {
    const { ctx, fakes } = makeTestCtx();
    const id = await finish(ctx, fakes, ["Needs a maintainer on concerto to review #812"]);
    expect((await ctx.db.getTask(id))?.status).toBe("blocked");
    expect((await ctx.db.openTasks("mira")).map((t) => t.id)).toEqual([id]);

    const wakes = adaWakes(fakes);
    expect(wakes).toHaveLength(1);
    expect(wakes[0].args[0].budgetCents).toBe(50);
    // Gateway-started follow-ups run on Ada's follow_up task model (C-9, decision 268), not her Opus default.
    expect(wakes[0].args[0].model).toEqual({ id: "claude-sonnet-5-5", effort: "low" });
    expect((await ctx.db.activeSessions("ada"))[0]).toMatchObject({ model: "claude-sonnet-5-5" });
    expect(wakes[0].args[0].text).toContain(`task ${id} for Mira`);
    expect(wakes[0].args[0].text).toContain("Needs a maintainer on concerto to review #812");
    expect(wakes[0].args[0].text).toContain('"Following up"');
    expect((await ctx.db.activeSessions("ada"))[0]).toMatchObject({ origin: "follow_up", started_by: "owner" });
    expect(await audit(ctx, "gateway.follow_up_woken")).toEqual([{ subject: id, of: "mira", started_by: "owner" }]);

    // Later passes over the same idle session change nothing.
    await processSession(ctx, "sesn_mira_task");
    expect(adaWakes(fakes)).toHaveLength(1);
  });

  it("uses the session's latest report, not an earlier one", async () => {
    const { ctx, fakes } = makeTestCtx();
    const task = await ctx.db.createTask({ agent: "mira", title: "t", brief: "b" });
    await ctx.db.upsertSession({ id: "sesn_two", agent: "mira", origin: "task", task_id: task.id });
    fakes.sessions.sesn_two = { id: "sesn_two", status: "idle", agent: { id: "agent_mira" }, stop_reason: { type: "end_turn" } };
    fakes.events.sesn_two = [
      { id: "r1", type: "agent.custom_tool_use", name: "report_status", input: { done: [], doing: [], blocked: ["CI red"] } },
      { id: "r2", type: "agent.custom_tool_use", name: "report_status", input: { done: ["CI green after retry"], doing: [], blocked: [] } },
    ];
    await processSession(ctx, "sesn_two");
    expect((await ctx.db.getTask(task.id))?.status).toBe("done");
  });

  it("shows blocked tasks in get_status and the status views", async () => {
    const { ctx, fakes } = makeTestCtx();
    const id = await finish(ctx, fakes, ["Waiting on D-3"]);
    const { handleTool } = await import("../src/tools");
    const st = JSON.parse(await handleTool(ctx, "ada", "sesn_x", "get_status", {}));
    expect(st.open_tasks.map((t: any) => [t.id, t.status])).toEqual([[id, "blocked"]]);
    const { gatherStatus, statusCards, statusPlain } = await import("../src/status");
    const s = await gatherStatus(ctx);
    expect(statusPlain(s)).toContain("tasks 1 (1 blocked)");
    expect(statusCards(s).embeds![1].description).toContain("1 open task (1 blocked)");
    expect(statusCards(s).embeds![1].description).toMatch(new RegExp(`\\n- ${id} · blocked · `));
    expect(statusPlain(s)).toMatch(new RegExp(`\\n  ${id} · blocked · `));
  });

  it("marks blockers reported before the last deploy", async () => {
    const { ctx } = makeTestCtx();
    await ctx.db.addStatus({ agent: "ada", session_id: "sesn_a", done: [], doing: [], blocked: ["No file tools this session"] });
    await (ctx.db as any).db.prepare("INSERT INTO deploys (commit_sha, ts) VALUES ('abc', datetime('now', '+1 minute'))").run();
    const { gatherStatus, statusCards } = await import("../src/status");
    const ada = statusCards(await gatherStatus(ctx)).embeds![0].description;
    expect(ada).toMatch(/\*\*Blocked\*\* · reported before the \d\d-\d\d \d\d:\d\d deploy, so it may be fixed\n- No file tools this session/);
  });

  it("refreshes live sessions before /status, so a missed webhook doesn't leave it stale", async () => {
    const { ctx, fakes } = makeTestCtx();
    const task = await ctx.db.createTask({ agent: "mira", title: "Chase the parser PRs", brief: "b" });
    await ctx.db.upsertSession({ id: "sesn_quiet", agent: "mira", origin: "task", task_id: task.id });
    await ctx.db.setTask(task.id, "running", "sesn_quiet");
    await ctx.db.upsertSession({ id: "sesn_busy", agent: "otto", origin: "deployment" });
    // The webhook for sesn_quiet's end was missed: Managed Agents has it idle, the gateway running.
    fakes.sessions.sesn_quiet = { id: "sesn_quiet", status: "idle", agent: { id: "agent_mira" }, stop_reason: { type: "end_turn" } };
    fakes.events.sesn_quiet = [{ id: "q1", type: "agent.custom_tool_use", name: "report_status", input: { done: ["Chased both PRs"], doing: [], blocked: [] } }];
    fakes.sessions.sesn_busy = { id: "sesn_busy", status: "running", agent: { id: "agent_otto" } };

    const { statusText } = await import("../src/commands");
    const text = await statusText(ctx);
    expect((await ctx.db.getTask(task.id))?.status).toBe("done");
    expect(text).toMatch(/Mira \(.*\) · active · tasks 0 ·.*\n  last report .* \(just now\): Chased both PRs/);
    expect(text).toMatch(/Otto \(.*\n  working now: 1 session, started just now/);
    expect(text).not.toMatch(/Mira \(.*\n  working now/);
  });

  it("refreshes at most REFRESH_LIMIT live sessions, and carries on past one that fails", async () => {
    const { ctx, fakes } = makeTestCtx();
    const { REFRESH_LIMIT, refreshLive } = await import("../src/status");
    for (let i = 0; i < REFRESH_LIMIT + 2; i++) {
      await ctx.db.upsertSession({ id: `sesn_l${i}`, agent: "mira", origin: "deployment" });
      fakes.sessions[`sesn_l${i}`] = { id: `sesn_l${i}`, status: "running", agent: { id: "agent_mira" } };
    }
    let fetched = 0;
    const retrieve = ctx.managed.retrieveSession;
    ctx.managed.retrieveSession = async (id: string) => {
      fetched++;
      if (id === "sesn_l0") throw new Error("boom");
      return retrieve(id);
    };
    await expect(refreshLive(ctx)).resolves.toBeUndefined();
    expect(fetched).toBe(REFRESH_LIMIT);
  });

  it("wakes Ada at most once per task", async () => {
    const { ctx, fakes } = makeTestCtx();
    const id = await finish(ctx, fakes, ["x"]);
    const { wakeAda } = await import("../src/followUp");
    const task = (await ctx.db.getTask(id))!;
    expect(await wakeAda(ctx, { kind: "task", task, blockers: ["x"] })).toBe("skipped");
    expect(adaWakes(fakes)).toHaveLength(1);
    expect((await audit(ctx, "gateway.follow_up_skipped")).map((d: any) => d.reason)).toEqual(["already woken for this id"]);
  });

  it("stops waking Ada at the daily cap", async () => {
    const network = { ...makeTestCtx().ctx.network, follow_up: { daily_wakes: 2, budget_cents: 50 } };
    const { ctx, fakes } = makeTestCtx({ network });
    for (const n of [1, 2, 3]) await finish(ctx, fakes, ["x"], { sid: `sesn_cap${n}` });
    expect(adaWakes(fakes)).toHaveLength(2);
    expect((await audit(ctx, "gateway.follow_up_skipped")).map((d: any) => [d.subject, d.reason])).toEqual([["T-3", "daily cap of 2 wakes reached"]]);
  });

  it("never wakes a stopped or paused Ada, or when schedules are off, and says why", async () => {
    const { ctx, fakes } = makeTestCtx();
    await ctx.db.setAgentStatus("ada", "stopped");
    await finish(ctx, fakes, ["x"], { sid: "sesn_a" });
    await ctx.db.setAgentStatus("ada", "paused");
    await finish(ctx, fakes, ["x"], { sid: "sesn_b" });
    const off = makeTestCtx({ network: { ...makeTestCtx().ctx.network, schedules_enabled: false } });
    await finish(off.ctx, off.fakes, ["x"]);
    expect(adaWakes(fakes)).toHaveLength(0);
    expect(adaWakes(off.fakes)).toHaveLength(0);
    expect((await audit(ctx, "gateway.follow_up_skipped")).map((d: any) => d.reason)).toEqual(["Ada is stopped", "Ada is paused"]);
    expect((await audit(off.ctx, "gateway.follow_up_skipped")).map((d: any) => d.reason)).toEqual(["schedules are off (network.schedules_enabled)"]);
    expect((await ctx.db.getTask("T-1"))?.status).toBe("blocked");
  });

  it("doesn't wake Ada about review checks", async () => {
    const { ctx, fakes } = makeTestCtx();
    const task = await ctx.db.createTask({ agent: "mira", title: "Review check", brief: "b", review: { target: "accordproject/concerto#1", sha: "abc1234" } });
    await ctx.db.upsertSession({ id: "sesn_rc", agent: "mira", origin: "task", task_id: task.id });
    fakes.sessions.sesn_rc = { id: "sesn_rc", status: "idle", agent: { id: "agent_mira" }, stop_reason: { type: "end_turn" } };
    fakes.events.sesn_rc = [{ id: "rc1", type: "agent.custom_tool_use", name: "report_status", input: { done: [], doing: [], blocked: ["head moved"] } }];
    await processSession(ctx, "sesn_rc");
    expect((await ctx.db.getTask(task.id))?.status).toBe("blocked");
    expect(adaWakes(fakes)).toHaveLength(0);
  });

  it("ends a review check done once its review is posted at that head, even if the merge was refused", async () => {
    const { ctx, fakes } = makeTestCtx();
    const reviewCheck = async (sid: string, sha7: string, blocked: string[] | null = ["merge not queued: review required"]) => {
      const task = await ctx.db.createTask({ agent: "mira", title: "Review check", brief: "b", review: { target: "accordproject/concerto#1", sha: sha7 } });
      await ctx.db.upsertSession({ id: sid, agent: "mira", origin: "task", task_id: task.id });
      await ctx.db.setTask(task.id, "running", sid);
      fakes.sessions[sid] = { id: sid, status: "idle", agent: { id: "agent_mira" }, stop_reason: { type: "end_turn" } };
      fakes.events[sid] = blocked ? [{ id: `${sid}_e1`, type: "agent.custom_tool_use", name: "report_status", input: { done: [], doing: [], blocked } }] : [];
      return task.id as string;
    };
    await ctx.db.createReview({ target: "accordproject/concerto#1", sha: "abc1234def5678", risk: "low", verdict: "approve", decision_id: "D-1", url: null, findings: [] });
    const posted = await reviewCheck("sesn_rc_posted", "abc1234");
    await processSession(ctx, "sesn_rc_posted");
    expect((await ctx.db.getTask(posted))?.status).toBe("done");
    expect((await audit(ctx, "gateway.review_check_done"))[0]).toMatchObject({ task: posted, blockers: ["merge not queued: review required"] });
    // A review at another head doesn't count: this check never posted its own.
    const other = await reviewCheck("sesn_rc_other", "fff0000");
    await processSession(ctx, "sesn_rc_other");
    expect((await ctx.db.getTask(other))?.status).toBe("blocked");
    // With no review at its head, an empty report or no report at all still leaves it blocked, and says why.
    const clean = await reviewCheck("sesn_rc_clean", "eee0000", []);
    await processSession(ctx, "sesn_rc_clean");
    expect(await ctx.db.getTask(clean)).toMatchObject({ status: "blocked", blocked_reason: "No review posted at eee0000" });
    const silent = await reviewCheck("sesn_rc_silent", "ddd0000", null);
    await processSession(ctx, "sesn_rc_silent");
    expect(await ctx.db.getTask(silent)).toMatchObject({ status: "blocked", blocked_reason: "No review posted at ddd0000" });
    // A posted review with a clean report is done, with nothing to audit.
    await ctx.db.createReview({ target: "accordproject/concerto#1", sha: "ccc0000aaa", risk: "low", verdict: "approve", decision_id: "D-2", url: null, findings: [] });
    const tidy = await reviewCheck("sesn_rc_tidy", "ccc0000", []);
    await processSession(ctx, "sesn_rc_tidy");
    expect((await ctx.db.getTask(tidy))?.status).toBe("done");
    expect(await audit(ctx, "gateway.review_check_done")).toHaveLength(1);
    expect(adaWakes(fakes)).toHaveLength(0);
  });

  it("keeps processing the session when waking Ada fails, and audits it", async () => {
    const { ctx, fakes } = makeTestCtx();
    const create = ctx.managed.createSession.bind(ctx.managed);
    (ctx.managed as any).createSession = async (p: any) => {
      if (p.agentId === "agent_ada") throw new Error("Managed Agents down");
      return create(p);
    };
    const id = await finish(ctx, fakes, ["x"]);
    expect((await ctx.db.getTask(id))?.status).toBe("blocked");
    expect(fakes.calls.filter((c) => c.method === "sendToolResult")).toHaveLength(1);
    expect(await audit(ctx, "gateway.follow_up_error")).toEqual([{ subject: id, of: "mira", error: "Managed Agents down" }]);
    // A failed wake isn't counted towards the daily cap.
    expect((await (ctx.db as any).db.prepare("SELECT status FROM follow_ups").all()).results).toEqual([{ status: "failed" }]);
  });

  it("closes a blocked task when its follow-up finishes", async () => {
    const { ctx, fakes } = makeTestCtx();
    const blocked = await finish(ctx, fakes, ["x"], { sid: "sesn_first" });
    const followUp = await finish(ctx, fakes, [], { agent: "otto", sid: "sesn_second", follows_up: blocked });
    expect((await ctx.db.getTask(followUp))?.status).toBe("done");
    expect((await ctx.db.getTask(blocked))?.status).toBe("done");
  });

  it("tells Ada when a blocked task was itself a follow-up", async () => {
    const { ctx, fakes } = makeTestCtx();
    const first = await finish(ctx, fakes, ["x"], { sid: "sesn_first" });
    await finish(ctx, fakes, ["still stuck"], { agent: "otto", sid: "sesn_second", follows_up: first });
    expect(adaWakes(fakes).at(-1).args[0].text).toContain(`It was itself a follow-up of ${first}: put it to Matt`);
  });
});

describe("tasks whose session stops without finishing (decision 53)", () => {
  const adaWakes = (fakes: any) => fakes.calls.filter((c: any) => c.method === "createSession" && c.args[0].agentId === "agent_ada");

  /** A running task for Mira whose session is in the given state. */
  async function started(ctx: any, fakes: any, sid: string, session: Record<string, unknown>) {
    const task = await ctx.db.createTask({ agent: "mira", title: "Chase the parser PRs", brief: "b" });
    await ctx.db.upsertSession({ id: sid, agent: "mira", origin: "task", task_id: task.id, started_by: "owner" });
    await ctx.db.setTask(task.id, "running", sid);
    fakes.sessions[sid] = { id: sid, agent: { id: "agent_mira" }, ...session };
    fakes.events[sid] = [];
    return task.id as string;
  }

  it("blocks a task whose session ran out of budget, says why, and wakes Ada about it", async () => {
    const { ctx, fakes } = makeTestCtx();
    const id = await started(ctx, fakes, "sesn_b", { status: "idle", stop_reason: { type: "budget_reached" } });
    await processSession(ctx, "sesn_b");
    expect(await ctx.db.getTask(id)).toMatchObject({ status: "blocked", blocked_reason: "Ran out of its session budget before finishing" });
    expect(adaWakes(fakes)[0].args[0].text).toContain("Ran out of its session budget before finishing");
  });

  it("blocks a task whose session ended in error, so Ada decides what happens to it", async () => {
    const { ctx, fakes } = makeTestCtx();
    const gone = await started(ctx, fakes, "sesn_t", { status: "terminated" });
    const retries = await started(ctx, fakes, "sesn_r", { status: "idle", stop_reason: { type: "retries_exhausted" } });
    await processSession(ctx, "sesn_t");
    await processSession(ctx, "sesn_r");
    for (const id of [gone, retries]) {
      expect(await ctx.db.getTask(id)).toMatchObject({ status: "blocked", blocked_reason: "Session ended in error before finishing" });
    }
    expect(adaWakes(fakes)).toHaveLength(2);
    expect((await ctx.db.openTasks()).map((t) => t.id)).toEqual([gone, retries]);
  });

  it("leaves running and paused sessions' tasks alone", async () => {
    const { ctx, fakes } = makeTestCtx();
    const running = await started(ctx, fakes, "sesn_run", { status: "running" });
    const paused = await started(ctx, fakes, "sesn_p", { status: "idle", stop_reason: { type: "requires_action" } });
    await processSession(ctx, "sesn_run");
    await processSession(ctx, "sesn_p");
    expect((await ctx.db.getTask(running))?.status).toBe("running");
    expect((await ctx.db.getTask(paused))?.status).toBe("running");
  });

  it("blocks old tasks at the tidy-up once their session is stale or gone, with the reason, and wakes no one", async () => {
    const { ctx, fakes } = makeTestCtx();
    const sql = (q: string) => (ctx.db as any).db.prepare(q).run();
    const task = async (sid: string | null, status: string) => {
      const t = await ctx.db.createTask({ agent: "mira", title: "t", brief: "b" });
      if (sid) {
        await ctx.db.upsertSession({ id: sid, agent: "mira", origin: "task", task_id: t.id, status });
        await ctx.db.setTask(t.id, "running", sid);
      }
      return t.id;
    };
    const stale = await task("sesn_old", "idle:budget_reached");
    const live = await task("sesn_live", "running");
    const recent = await task("sesn_new", "idle:budget_reached");
    const orphan = await task(null, "");
    await sql("UPDATE sessions SET updated_at = datetime('now', '-8 days') WHERE id = 'sesn_old'");
    await sql(`UPDATE tasks SET created_at = datetime('now', '-8 days') WHERE id = '${orphan}'`);
    await housekeeping(ctx);
    const state = async (id: string) => {
      const t = await ctx.db.getTask(id);
      return [t?.status, t?.blocked_reason];
    };
    expect(await state(stale)).toEqual(["blocked", "No activity for 7 days; the session is over"]);
    expect(await state(orphan)).toEqual(["blocked", "Never started a session"]);
    expect(await state(live)).toEqual(["running", null]);
    expect(await state(recent)).toEqual(["running", null]);
    const row: any = await (ctx.db as any).db.prepare("SELECT detail FROM audit WHERE event_type = 'gateway.housekeeping'").first();
    expect(JSON.parse(row.detail).blocked_tasks).toEqual([stale, orphan]);
    expect(adaWakes(fakes)).toHaveLength(0);
  });
});

describe("session memory stores", () => {
  it("mounts every store after the first read-only", async () => {
    const otto = { ...DEPLOYED.agents.otto, memory_store_ids: ["mem_otto", "mem_shared", "mem_sage"] };
    const { ctx, fakes } = makeTestCtx({ deployed: { ...DEPLOYED, agents: { ...DEPLOYED.agents, otto } } });
    await startSession(ctx, "otto", "x", "task", "owner");
    const call = fakes.calls.find((c) => c.method === "createSession")!;
    expect((call.args[0] as { memoryStoreIds: unknown }).memoryStoreIds).toEqual([
      { id: "mem_otto", access: "read_write" },
      { id: "mem_shared", access: "read_only" },
      { id: "mem_sage", access: "read_only" },
    ]);
  });
});

describe("the five-minute cron's database reads", () => {
  // D1's free tier counts every row a query scans, and the cron runs 288 times a day,
  // so its queries must read through an index, not scan whole tables.
  // The daily check's target list may scan: it runs only until the day's allowance is used.
  const BOUNDED = ["FROM decisions WHERE status = 'open' AND kind LIKE 'github.%'"];
  // Partial indexes hold only the rows a query wants, so walking one is not a table scan.
  const PARTIAL = ["USING INDEX sessions_unfinished"];

  it("reads through indexes", async () => {
    const seen = new Set<string>();
    const d1 = memoryD1(seen);
    const gh = fakeGitHub();
    const network = { ...NETWORK, github_wakes: { review: { daily: 6, budget_cents: 100 } }, triage_checks: { after: "08:00", times: ["13:00"], budget_cents: 100 } };
    const { ctx } = makeTestCtx({ db: new Db(d1), network, github: async () => gh as never });
    await ctx.db.upsertSession({ id: "sesn_run", agent: "mira", origin: "task", status: "running" });
    const now = new Date("2026-11-11T13:01:00Z");
    await housekeeping(ctx, now);
    await tickChanges(ctx, now);
    await sweep(ctx);
    await triageCheck(ctx, now);
    await dailyCheck(ctx, now);
    await dispatchWakes(ctx);
    gh.history["accordproject/concerto"] = [[{ number: 1, state: "OPEN", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z", closedAt: null, mergedAt: null, author: { login: "a" }, reviews: { nodes: [] }, comments: { nodes: [] } }]];
    await syncPrHistory(ctx, now);
    await runSchedules({ ...ctx, network: { ...ctx.network, gateway_schedules: [{ name: "x", agent: "mira", cron: "0 13 * * *", task: "triage", prompt: "p", budget_cents: 100 }] } }, now);
    const scans = [...seen]
      .filter((sql) => !BOUNDED.some((b) => sql.includes(b)))
      .map((sql) => {
        const params = Array((sql.match(/\?/g) ?? []).length).fill("x");
        const plan = d1.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[];
        return { sql: sql.replace(/\s+/g, " ").slice(0, 120), scans: plan.map((p) => p.detail).filter((d) => d.startsWith("SCAN") && !PARTIAL.some((i) => d.endsWith(i))) };
      })
      .filter((q) => q.scans.length);
    expect(scans).toEqual([]);
    expect(seen.size).toBeGreaterThan(10);
  });

  it("tidies once an hour", async () => {
    const seen = new Set<string>();
    const { ctx } = makeTestCtx({ db: new Db(memoryD1(seen)) });
    await housekeeping(ctx, new Date("2026-11-11T13:01:00Z"));
    const pruned = () => [...seen].filter((s) => s.startsWith("DELETE FROM audit")).length;
    expect(pruned()).toBe(1);
    seen.clear();
    await housekeeping(ctx, new Date("2026-11-11T13:56:00Z"));
    expect(pruned()).toBe(0);
    await housekeeping(ctx, new Date("2026-11-11T14:01:00Z"));
    expect(pruned()).toBe(1);
  });

  it("counts one day's claims by key range", async () => {
    const { ctx } = makeTestCtx();
    for (const id of ["github-daily:2026-11-11:a#1", "github-daily:2026-11-11:b#2", "github-daily:2026-11-10:a#1", "github-daily:2026-11-12:a#1", "github-daily:2026-11-11", "x"]) {
      await ctx.db.claimEvent(id);
    }
    expect(await ctx.db.countClaims("github-daily:2026-11-11:")).toBe(2);
  });

  it("stops reading once the day's check allowance is used", async () => {
    const seen = new Set<string>();
    const { ctx } = makeTestCtx({ db: new Db(memoryD1(seen)), network: { ...NETWORK, github_wakes: { review: { daily: 6, budget_cents: 100 } } } });
    const { DAILY_CHECK } = await import("../src/githubEvents");
    for (let n = 0; n < DAILY_CHECK.total; n++) await ctx.db.claimEvent(`github-daily:2026-11-11:accordproject/concerto#${n}`);
    seen.clear();
    await dailyCheck(ctx, new Date("2026-11-11T13:01:00Z"));
    expect([...seen].some((s) => s.includes("github_checks"))).toBe(false);
  });
});

describe("schedules the gateway runs (decision 67)", () => {
  const TRIAGE = { name: "mira-triage", agent: "mira", cron: "0 8 * * *", task: "triage", prompt: "Triage pass.", budget_cents: 100 };
  const ctxWith = (schedules = [TRIAGE], over: Partial<typeof NETWORK> = {}) => makeTestCtx({ network: { ...NETWORK, gateway_schedules: schedules, ...over } });
  const sessions = (fakes: { calls: { method: string; args: any[] }[] }) => fakes.calls.filter((c) => c.method === "createSession").map((c) => c.args[0]);
  const audits = async (ctx: any, type: string) =>
    (await ctx.db.db.prepare("SELECT detail FROM audit WHERE event_type = ? ORDER BY id").bind(type).all()).results.map((r: any) => JSON.parse(r.detail));

  it("parses and matches cron in local time", () => {
    const c = parseCron("0 10 * * 1-5");
    // 2026-11-13 is a Friday: 10:00 in London is 10:00 UTC in winter.
    expect(cronMatches(c, localTime("Europe/London", new Date("2026-11-13T10:00:00Z")))).toBe(true);
    expect(cronMatches(c, localTime("Europe/London", new Date("2026-11-14T10:00:00Z")))).toBe(false);
    // Summer: 10:00 in London is 09:00 UTC.
    expect(cronMatches(c, localTime("Europe/London", new Date("2026-07-10T09:00:00Z")))).toBe(true);
    expect(cronMatches(parseCron("30 7 */2 * *"), localTime("Europe/London", new Date("2026-11-11T07:30:00Z")))).toBe(true);
    expect(cronMatches(parseCron("30 7 */2 * *"), localTime("Europe/London", new Date("2026-11-12T07:30:00Z")))).toBe(false);
    expect(cronMatches(parseCron("0 9 * * 7"), localTime("Europe/London", new Date("2026-11-15T09:00:00Z")))).toBe(true);
    expect(() => parseCron("0 8 * *")).toThrow(/5 fields/);
    expect(() => parseCron("0 25 * * *")).toThrow(/out of range/);
    expect(() => parseCron("0 8 * * MON")).toThrow(/not supported/);
  });

  it("starts a run once, on the task's model and effort, within the catch-up window", async () => {
    const { ctx, fakes } = ctxWith();
    await runSchedules(ctx, new Date("2026-11-11T07:59:00Z"));
    expect(sessions(fakes)).toEqual([]);
    await runSchedules(ctx, new Date("2026-11-11T08:03:00Z"));
    await runSchedules(ctx, new Date("2026-11-11T08:08:00Z"));
    const [s, ...rest] = sessions(fakes);
    expect(rest).toEqual([]);
    expect(s).toMatchObject({ agentId: "agent_mira", text: "Triage pass.", budgetCents: 100, model: { id: "claude-haiku-5-5", effort: "medium" } });
    expect(await ctx.db.getSession("sesn_1")).toMatchObject({ origin: "deployment", started_by: "schedule", model: "claude-haiku-5-5" });
    expect(await audits(ctx, "gateway.schedule_started")).toEqual([{ schedule: "mira-triage", at: "2026-11-11T08:00", task: "triage" }]);

    // Too late to catch up: a tick that comes after the window misses that day's run.
    const late = ctxWith();
    await runSchedules(late.ctx, new Date(Date.parse("2026-11-11T08:00:00Z") + CATCH_UP_MINUTES * 60_000));
    expect(sessions(late.fakes)).toEqual([]);
  });

  it("starts nothing with schedules off, and skips a paused agent with an audit", async () => {
    const off = ctxWith([TRIAGE], { schedules_enabled: false });
    await runSchedules(off.ctx, new Date("2026-11-11T08:01:00Z"));
    expect(sessions(off.fakes)).toEqual([]);

    const { ctx, fakes } = ctxWith();
    await ctx.db.setAgentStatus("mira", "paused");
    await runSchedules(ctx, new Date("2026-11-11T08:01:00Z"));
    expect(sessions(fakes)).toEqual([]);
    expect((await audits(ctx, "gateway.schedule_skipped"))[0]).toMatchObject({ schedule: "mira-triage", at: "2026-11-11T08:00", why: expect.stringMatching(/paused/i) });
  });
});
