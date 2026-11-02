import { describe, expect, it } from "vitest";
import { processSession } from "../src/sessions";
import { makeTestCtx } from "./helpers";

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

  it("records a scheduled session's tokens and default model, and never lowers them", async () => {
    const { ctx, fakes } = makeTestCtx();
    const usage = { list_cost: { amount: "42", currency: "USD" }, input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 9000, cache_creation_input_tokens: 50 };
    fakes.sessions.s4 = { id: "s4", status: "running", agent: { id: "agent_mira" }, usage };
    await processSession(ctx, "s4");
    expect(await ctx.db.getSession("s4")).toMatchObject({
      origin: "deployment", model: "claude-sonnet-5-5", cost_cents: 42, input_tokens: 1200, output_tokens: 300, cache_read_tokens: 9000, cache_write_tokens: 50,
    });
    fakes.sessions.s4 = { id: "s4", status: "idle", agent: { id: "agent_mira" }, stop_reason: { type: "end_turn" }, usage: { input_tokens: 10 } };
    await processSession(ctx, "s4");
    expect(await ctx.db.getSession("s4")).toMatchObject({ cost_cents: 42, input_tokens: 1200, status: "idle:end_turn" });
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
