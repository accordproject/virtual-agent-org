import { describe, expect, it } from "vitest";
import { handleUpdate } from "../src/commands";
import { approve, markDone, reject, stop } from "../src/controls";
import { parseTarget } from "../src/github";
import { processSession } from "../src/sessions";
import { splitText } from "../src/telegram";
import { handleTool, ToolError } from "../src/tools";
import { sign, verifyWebhook } from "../src/webhookVerify";
import { makeTestCtx } from "./helpers";

const SECRET = "whsec_" + btoa("0123456789abcdef0123456789abcdef");

describe("webhook verification", () => {
  it("accepts a valid signature and rejects tampering or stale timestamps", async () => {
    const now = 1_800_000_000;
    const body = '{"type":"event"}';
    const sig = await sign(SECRET, "whe_1", String(now), body);
    const h = (ts: number, s = sig) =>
      new Headers({ "webhook-id": "whe_1", "webhook-timestamp": String(ts), "webhook-signature": `v1,${s}` });
    expect(await verifyWebhook(SECRET, h(now), body, now)).toBe(true);
    expect(await verifyWebhook(SECRET, h(now), body + " ", now)).toBe(false);
    expect(await verifyWebhook(SECRET, h(now), body, now + 600)).toBe(false);
    expect(await verifyWebhook(SECRET, h(now, "AAAA"), body, now)).toBe(false);
  });
});

describe("request_action", () => {
  it("refuses kinds the agent may not request", async () => {
    const { ctx } = makeTestCtx();
    await expect(
      handleTool(ctx, "mira", "sesn_x", "request_action", {
        kind: "github.release", target: "a/b#1", summary: "s", rationale: "r", risk: "low",
      }),
    ).rejects.toBeInstanceOf(ToolError);
  });

  it("queues, raises risk to the kind's floor, sends a card, and never blocks", async () => {
    const { ctx, fakes } = makeTestCtx();
    const out = await handleTool(ctx, "mira", "sesn_x", "request_action", {
      kind: "github.merge", target: "accordproject/virtual-agent-org-sandbox#3", summary: "Merge docs fix", rationale: "CI green", risk: "low",
    });
    expect(out).toMatch(/^Queued as D-1\./);
    const d = await ctx.db.getDecision("D-1");
    expect(d?.risk).toBe("medium");
    expect(fakes.sent[0].text).toContain("D-1 · Mira · github.merge");
  });
});

describe("tool ownership and controls", () => {
  it("keeps Ada's tools for Ada", async () => {
    const { ctx } = makeTestCtx();
    await expect(handleTool(ctx, "mira", "s", "send_to_matt", { text: "hi" })).rejects.toThrow(/not available to mira/);
  });

  it("refuses to assign to an agent from a later phase", async () => {
    const { ctx } = makeTestCtx();
    await expect(handleTool(ctx, "ada", "s", "assign_task", { agent: "rosa", title: "t", objective: "o", output: "x", done_when: "d", effort: "small" })).rejects.toThrow(/phase 2/);
  });

  it("assigns a task by starting a session for the agent", async () => {
    const { ctx, fakes } = makeTestCtx();
    const out = await handleTool(ctx, "ada", "s", "assign_task", {
      agent: "mira",
      title: "Triage",
      objective: "Clear the sandbox queue",
      output: "a status report",
      done_when: "every open PR has a response",
      boundaries: "sandbox only",
      effort: "small",
    });
    expect(out).toBe("Assigned T-1 to Mira (small effort, $0.30 cap).");
    const create = fakes.calls.find((c) => c.method === "createSession")!.args[0] as any;
    expect(create.agentId).toBe("agent_mira");
    expect(create.budgetCents).toBe(30);
    expect(create.text).toContain("Task T-1");
    expect(create.text).toContain("Done when: every open PR has a response");
    expect(create.text).toContain("Out of scope: sandbox only");
    expect(create.text).toMatch(/Aim for about 10 tool calls/);
    expect((await ctx.db.openTasks("mira"))[0].status).toBe("running");
  });

  it("stop interrupts sessions, rejects open decisions, and blocks further tool use", async () => {
    const { ctx, fakes } = makeTestCtx();
    await ctx.db.upsertSession({ id: "sesn_live", agent: "mira", origin: "deployment" });
    await handleTool(ctx, "mira", "sesn_live", "request_action", {
      kind: "github.comment", target: "accordproject/virtual-agent-org-sandbox#1", summary: "s", rationale: "r", risk: "low",
    });
    const msg = await stop(ctx, "mira");
    expect(msg).toContain("1 session(s) interrupted, 1 open decision(s) rejected");
    expect(fakes.calls.some((c) => c.method === "pauseDeployment" && c.args[0] === "dep_mira")).toBe(true);
    await expect(handleTool(ctx, "mira", "sesn_live", "report_status", { done: [], doing: [], blocked: [] })).rejects.toThrow(
      /stopped/,
    );
  });
});

describe("approvals", () => {
  const queue = async (ctx: any, kind: string, target: string, payload = {}) =>
    handleTool(ctx, kind === "vimeo.publish" ? "otto" : "mira", "s", "request_action", {
      kind, target, summary: "s", rationale: "r", risk: "low", payload,
    });

  it("executes GitHub actions in dry run only for in-scope repos", async () => {
    const { ctx } = makeTestCtx();
    await queue(ctx, "github.merge", "accordproject/virtual-agent-org-sandbox#3");
    expect(await approve(ctx, "D-1")).toContain("DRY RUN");
    expect((await ctx.db.getDecision("D-1"))?.status).toBe("executed");

    await queue(ctx, "github.merge", "someone/else#1");
    expect(await approve(ctx, "D-2")).toContain("not in the configured repos");
    expect((await ctx.db.getDecision("D-2"))?.status).toBe("failed");
    expect(await approve(ctx, "D-2")).toBe("D-2 is not open.");
  });

  it("hands manual actions back to the owner until marked done", async () => {
    const { ctx } = makeTestCtx();
    await queue(ctx, "linkedin.post", "linkedin", { text: "Post text" });
    expect(await approve(ctx, "D-1")).toContain("Mark done");
    expect((await ctx.db.getDecision("D-1"))?.status).toBe("approved");
    await markDone(ctx, "D-1");
    expect((await ctx.db.getDecision("D-1"))?.status).toBe("executed");
  });

  it("denies a paused tool call on rejection, then accepts a later note", async () => {
    const { ctx, fakes } = makeTestCtx();
    const d = await ctx.db.createDecision({
      agent: "mira", kind: "tool.confirm", target: "mcp__github__push", summary: "s", rationale: "r", risk: "high",
      session_id: "sesn_9", tool_use_id: "evt_9",
    });
    await reject(ctx, d.id);
    const conf = fakes.calls.find((c) => c.method === "sendToolConfirmation")!;
    expect(conf.args.slice(0, 3)).toEqual(["sesn_9", "evt_9", false]);
    expect(await reject(ctx, d.id, "Use a fork")).toBe(`Note added to ${d.id}.`);
    expect((await ctx.db.getDecision(d.id))?.note).toBe("Use a fork");
  });
});

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
  });
});

describe("telegram", () => {
  it("ignores strangers and asks for confirmation before revoking", async () => {
    const { ctx, fakes } = makeTestCtx();
    await handleUpdate(ctx, { update_id: 1, message: { message_id: 1, from: { id: 999 }, chat: { id: 999, type: "private" }, text: "/stop all" } });
    expect(fakes.sent).toHaveLength(0);
    await handleUpdate(ctx, { update_id: 2, message: { message_id: 2, from: { id: 42 }, chat: { id: 42, type: "private" }, text: "/revoke mira" } });
    expect(fakes.sent[0].text).toContain("/revoke mira confirm");
    expect(await ctx.db.agentStatus("mira")).toBe("active");
  });

  it("does not let TSC members approve", async () => {
    const { ctx, fakes } = makeTestCtx();
    await handleUpdate(ctx, { update_id: 3, message: { message_id: 3, from: { id: 77 }, chat: { id: 77, type: "private" }, text: "/approve D-1" } });
    expect(fakes.sent).toHaveLength(0);
  });
});

describe("parsing", () => {
  it("parses GitHub targets", () => {
    expect(parseTarget("https://github.com/accordproject/concerto/pull/812")).toEqual({ owner: "accordproject", repo: "concerto", number: 812 });
    expect(parseTarget("accordproject/concerto#5")).toEqual({ owner: "accordproject", repo: "concerto", number: 5 });
    expect(parseTarget("nonsense")).toBeNull();
  });

  it("splits long Telegram messages on line breaks", () => {
    const parts = splitText(Array.from({ length: 300 }, (_, i) => `line ${i}`.padEnd(30, ".")).join("\n"), 4000);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 4000)).toBe(true);
  });
});

describe("fetch binding (Workers rejects fetch called with another `this`)", () => {
  it("clients call the global fetch unbound", async () => {
    const real = globalThis.fetch;
    const strict = function (this: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })));
    } as unknown as typeof fetch;
    globalThis.fetch = strict;
    try {
      const { Telegram } = await import("../src/telegram");
      const { ManagedClient } = await import("../src/managed");
      const { DiscordBot } = await import("../src/discordBot");
      await expect(new Telegram("t").send(1, "hi")).resolves.toBe(1);
      await expect(new ManagedClient("k").retrieveSession("s")).resolves.toBeDefined();
      await expect(new DiscordBot("t", "a").post("123456", "hi")).resolves.toBe(1);
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("discord announcements", () => {
  const queueAnnounce = (ctx: any, text = "Tech WG summary") =>
    handleTool(ctx, "otto", "s", "request_action", {
      kind: "discord.announce", target: "discord:#announcements", summary: "Post Tech WG summary", rationale: "r", risk: "low",
      payload: { text },
    });

  it("posts the approved text to the announcements channel", async () => {
    const { ctx, fakes } = makeTestCtx({ dryRun: false });
    await queueAnnounce(ctx);
    expect(await approve(ctx, "D-1")).toBe("D-1: Posted to Discord");
    expect(fakes.discord).toEqual(["Tech WG summary"]);
    expect((await ctx.db.getDecision("D-1"))?.status).toBe("executed");
  });

  it("falls back to manual posting when no channel is set", async () => {
    const { ctx, fakes } = makeTestCtx({ dryRun: false });
    ctx.discord = { configured: false, post: async () => 0 };
    await queueAnnounce(ctx);
    expect(await approve(ctx, "D-1")).toContain("Mark done");
    expect(fakes.discord).toHaveLength(0);
    expect((await ctx.db.getDecision("D-1"))?.status).toBe("approved");
  });

  it("the bot posts to the channel, only labels, never pings, and splits long posts", async () => {
    const { DiscordBot } = await import("../src/discordBot");
    const { withLabel, AGENT_LABEL } = await import("../src/discord");
    const bodies: any[] = [];
    const calls: { url: string; auth: string }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, auth: (init.headers as any).authorization });
      bodies.push(JSON.parse(String(init.body)));
      return new Response("{}");
    }) as unknown as typeof fetch;
    const long = Array.from({ length: 120 }, (_, i) => `line ${i} @everyone`.padEnd(40, ".")).join("\n");
    const n = await new DiscordBot("tok", "app", fake).post("987654321", long);
    expect(n).toBeGreaterThan(1);
    expect(bodies.every((b) => b.content.length <= 2000 && b.allowed_mentions.parse.length === 0 && b.allowed_mentions.users.length === 0)).toBe(true);
    expect(calls.every((c) => c.url === "https://discord.com/api/v10/channels/987654321/messages" && c.auth === "Bot tok")).toBe(true);
    expect(bodies.at(-1).content).toContain(AGENT_LABEL);
    expect(withLabel(`Hi\n\n${AGENT_LABEL}`).match(new RegExp(AGENT_LABEL, "g"))).toHaveLength(1);
  });
});

describe("people", () => {
  it("describes people by their roles", async () => {
    const { describePerson } = await import("../src/people");
    const { ctx } = makeTestCtx();
    expect(describePerson(ctx, "telegram", 66)).toBe("Sam Lee (TSC member, maintainer of accordproject/concerto)");
    expect(describePerson(ctx, "discord", "223456789012345678")).toBe("Ali Khan (maintainer)");
  });

  it("gives listed people read-and-ask access, and never owner rights", async () => {
    const { roleFor, displayName } = await import("../src/people");
    const { ctx } = makeTestCtx();
    expect(roleFor(ctx, "telegram", 42)).toBe("owner"); // the secret
    expect(roleFor(ctx, "telegram", 555)).toBe("member"); // listed as owner in people.yaml, but not the secret
    expect(roleFor(ctx, "telegram", 88)).toBe("member");
    expect(roleFor(ctx, "discord", "123456789012345678")).toBe("member");
    expect(roleFor(ctx, "discord", "223456789012345678")).toBe("member"); // maintainers too
    expect(roleFor(ctx, "telegram", 999)).toBeNull();
    expect(displayName(ctx, "telegram", 88)).toBe("Jane Doe");
  });

  it("names TSC members to Ada and ignores group chatter", async () => {
    const { ctx, fakes } = makeTestCtx();
    await handleUpdate(ctx, { update_id: 9, message: { message_id: 9, from: { id: 88 }, chat: { id: -5, type: "group" }, text: "hello all" } });
    expect(fakes.calls.some((c) => c.method === "createSession")).toBe(false);
    await handleUpdate(ctx, { update_id: 10, message: { message_id: 10, from: { id: 88 }, chat: { id: 88, type: "private" }, text: "How is triage going?" } });
    const create = fakes.calls.find((c) => c.method === "createSession")!.args[0] as any;
    expect(create.text).toMatch(/^Jane Doe \(TSC member\) asks/);
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

describe("discord bot (decision 15B)", () => {
  const OWNER = "111111111111111111";
  const JANE = "123456789012345678";
  const run = async (ctx: any, i: any) => {
    const pending: Promise<unknown>[] = [];
    const { handleInteraction } = await import("../src/discordInteractions");
    const res: any = await handleInteraction(ctx, { token: "tok", ...i }, (p) => pending.push(p));
    await Promise.all(pending);
    return res;
  };
  const cmd = (user: string, name: string, options: Record<string, string> = {}) => ({
    type: 2,
    member: { user: { id: user } },
    data: { name, options: Object.entries(options).map(([name, value]) => ({ name, value })) },
  });
  const click = (user: string, custom_id: string) => ({ type: 3, user: { id: user }, data: { custom_id } });
  const queue = (ctx: any, kind: string, target: string, agent = "mira") =>
    handleTool(ctx, agent, "s", "request_action", { kind, target, summary: "s", rationale: "r", risk: "low", payload: { text: "hi" } });

  it("verifies Discord's Ed25519 signature", async () => {
    const { verifyDiscord } = await import("../src/discordBot");
    const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const pub = Buffer.from(await crypto.subtle.exportKey("raw", kp.publicKey)).toString("hex");
    const body = '{"type":1}';
    const sig = Buffer.from(await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode("1700000000" + body))).toString("hex");
    const h = (s: string) => new Headers({ "x-signature-ed25519": s, "x-signature-timestamp": "1700000000" });
    expect(await verifyDiscord(pub, h(sig), body)).toBe(true);
    expect(await verifyDiscord(pub, h(sig), body + " ")).toBe(false);
    expect(await verifyDiscord(pub, h("00".repeat(64)), body)).toBe(false);
  });

  it("answers pings and turns away people who aren't listed", async () => {
    const { ctx, fakes } = makeTestCtx();
    expect(await run(ctx, { type: 1 })).toEqual({ type: 1 });
    const res = await run(ctx, cmd("999", "ada", { message: "hi" }));
    expect(res.data.content).toMatch(/not set up/);
    expect(fakes.calls.some((c) => c.method === "createSession")).toBe(false);
  });

  it("lets the owner instruct Ada and sends her replies to Discord DMs", async () => {
    const { ctx, fakes } = makeTestCtx();
    const res = await run(ctx, cmd(OWNER, "ada", { message: "Triage the sandbox" }));
    expect(res.data.content).toMatch(/Sent to Ada/);
    expect(res.data.flags).toBe(64);
    const create = fakes.calls.find((c) => c.method === "createSession")!.args[0] as any;
    expect(create.text).toBe("Triage the sandbox");
    const sid = Object.keys(fakes.sessions)[0];
    fakes.sessions[sid] = { id: sid, status: "idle", agent: "agent_ada", stop_reason: { type: "end_turn" } };
    fakes.events[sid] = [{ id: "e1", type: "agent.message", content: [{ type: "text", text: "Assigned T-1 to Mira." }] }];
    await processSession(ctx, sid);
    expect(fakes.dms).toEqual([{ user: OWNER, content: "Ada: Assigned T-1 to Mira." }]);
    expect(fakes.sent).toHaveLength(0); // nothing leaks to Telegram
  });

  it("labels members' messages to Ada as ask-only", async () => {
    const { ctx, fakes } = makeTestCtx();
    await run(ctx, cmd(JANE, "ada", { message: "How's triage?" }));
    const create = fakes.calls.find((c) => c.method === "createSession")!.args[0] as any;
    expect(create.text).toMatch(/^Jane Doe \(TSC member\) asks on Discord\. They cannot instruct or approve/);
  });

  it("owner rights on Discord come only from the secret", async () => {
    const { roleFor } = await import("../src/people");
    const { ctx } = makeTestCtx();
    expect(roleFor(ctx, "discord", OWNER)).toBe("owner");
    ctx.ownerDiscordId = undefined;
    expect(roleFor(ctx, "discord", OWNER)).toBeNull();
    expect(roleFor(ctx, "discord", JANE)).toBe("member");
  });

  it("DMs medium-risk cards, approves from a button, and updates both apps", async () => {
    const { ctx, fakes } = makeTestCtx();
    await queue(ctx, "github.merge", "accordproject/virtual-agent-org-sandbox#3");
    expect(fakes.sent).toHaveLength(1); // Telegram card
    expect(fakes.dms).toHaveLength(1); // Discord card
    expect(fakes.dms[0].buttons).toHaveLength(3);
    const res = await run(ctx, click(OWNER, "a:D-1"));
    expect(res).toEqual({ type: 6 });
    expect((await ctx.db.getDecision("D-1"))?.status).toBe("executed");
    expect(fakes.dcEdits.at(-1)?.content).toContain("**Result:** DRY RUN");
    expect(fakes.dcEdits.at(-1)?.buttons).toEqual([]);
  });

  it("keeps high-risk decisions and tool calls in Telegram", async () => {
    const { ctx, fakes } = makeTestCtx();
    const { postDecision } = await import("../src/agents");
    const high = await ctx.db.createDecision({ agent: "mira", kind: "github.merge", target: "x", summary: "s", rationale: "r", risk: "high" });
    const tool = await ctx.db.createDecision({
      agent: "mira", kind: "tool.confirm", target: "bash", summary: "s", rationale: "r", risk: "medium", session_id: "s1", tool_use_id: "t1",
    });
    await postDecision(ctx, high);
    await postDecision(ctx, tool);
    expect(fakes.sent).toHaveLength(2); // both reach Telegram
    expect(fakes.dms).toHaveLength(0); // neither reaches Discord
    for (const d of [high, tool]) {
      const res = await run(ctx, click(OWNER, `a:${d.id}`));
      expect(res.data.content).toMatch(/approve it in Telegram/);
      expect((await ctx.db.getDecision(d.id))?.status).toBe("open");
    }
  });

  it("refuses button clicks from anyone but the owner", async () => {
    const { ctx } = makeTestCtx();
    await queue(ctx, "github.merge", "accordproject/virtual-agent-org-sandbox#3");
    const res = await run(ctx, click(JANE, "a:D-1"));
    expect(res.data.content).toMatch(/Only the owner/);
    expect((await ctx.db.getDecision("D-1"))?.status).toBe("open");
  });

  it("rejects through a form with an optional note", async () => {
    const { ctx } = makeTestCtx();
    await queue(ctx, "github.merge", "accordproject/virtual-agent-org-sandbox#3");
    const modal = await run(ctx, click(OWNER, "r:D-1"));
    expect(modal.type).toBe(9);
    expect(modal.data.custom_id).toBe("rn:D-1");
    await run(ctx, { type: 5, user: { id: OWNER }, data: { custom_id: "rn:D-1", components: [{ components: [{ custom_id: "note", value: "Needs tests" }] }] } });
    const d = await ctx.db.getDecision("D-1");
    expect(d?.status).toBe("rejected");
    expect(d?.note).toBe("Needs tests");
  });

  it("lets the owner stop agents but not resume or revoke from Discord", async () => {
    const { ctx, fakes } = makeTestCtx();
    expect((await run(ctx, cmd(JANE, "stop", { agent: "mira" }))).data.content).toMatch(/Only the owner/);
    const res = await run(ctx, cmd(OWNER, "stop", { agent: "mira" }));
    expect(res.type).toBe(5);
    expect(await ctx.db.agentStatus("mira")).toBe("stopped");
    expect(fakes.originals[0].content).toMatch(/Mira stopped/);
    expect((await run(ctx, cmd(OWNER, "revoke", { agent: "mira" }))).data.content).toMatch(/Telegram-only/);
  });

  it("registers commands that list only active agents", async () => {
    const { commandDefinitions } = await import("../src/discordInteractions");
    const defs = commandDefinitions(["ada", "mira"]);
    expect(defs.map((d) => d.name)).toEqual(["ada", "ask", "status", "queue", "pause", "stop"]);
    const ask = defs.find((d) => d.name === "ask") as any;
    expect(ask.options[0].choices.map((c: any) => c.value)).toEqual(["ada", "mira"]);
  });
});

describe("sessions that are waiting", () => {
  it("starts a fresh session when the last one is paused on a tool call", async () => {
    const { ManagedAgentsError } = await import("../src/managed");
    const { messageAgent } = await import("../src/agents");
    const { ctx, fakes } = makeTestCtx();
    const first = await messageAgent(ctx, "ada", { discord: "111111111111111111" }, "hello");
    (ctx.managed as any).sendMessage = async () => {
      throw new ManagedAgentsError(400, '{"error":{"message":"Invalid user.message event at events[0]: waiting on responses to events [sevt_1]"}}', "/sessions/x/events");
    };
    const second = await messageAgent(ctx, "ada", { discord: "111111111111111111" }, "are you there?");
    expect(second).not.toBe(first);
    expect(fakes.calls.filter((c) => c.method === "createSession")).toHaveLength(2);
    // and the next message continues the new session, not the paused one
    (ctx.managed as any).sendMessage = async (id: string) => fakes.calls.push({ method: "sendMessage", args: [id] });
    await messageAgent(ctx, "ada", { discord: "111111111111111111" }, "thanks");
    expect(fakes.calls.at(-1)).toEqual({ method: "sendMessage", args: [second] });
  });

  it("does not hide other errors when continuing a session", async () => {
    const { ManagedAgentsError } = await import("../src/managed");
    const { messageAgent } = await import("../src/agents");
    const { ctx } = makeTestCtx();
    await messageAgent(ctx, "ada", { telegram: 42 }, "hello");
    (ctx.managed as any).sendMessage = async () => {
      throw new ManagedAgentsError(500, "boom", "/sessions/x/events");
    };
    await expect(messageAgent(ctx, "ada", { telegram: 42 }, "again")).rejects.toThrow(/500/);
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

describe("#agent-ops pings", () => {
  const ping = (ctx: any, mention: unknown, text = "PR #3 has waited 4 days for review") =>
    handleTool(ctx, "mira", "s", "request_action", {
      kind: "discord.ops", target: "discord:#agent-ops", summary: "Nudge reviewers", rationale: "r", risk: "low",
      payload: { text, mention },
    });

  it("shows who will be pinged on the card, and pings only them once approved", async () => {
    const { ctx, fakes } = makeTestCtx({ dryRun: false });
    await ping(ctx, ["@alikhan", "Jane Doe"]);
    expect(fakes.sent[0].text).toContain("Pings: @alikhan, @Jane Doe");
    expect(await approve(ctx, "D-1")).toBe("D-1: Posted to #agent-ops pinging Ali Khan, Jane Doe");
    expect(fakes.ops).toEqual([{ text: "PR #3 has waited 4 days for review", ids: ["223456789012345678", "123456789012345678"] }]);
  });

  it("refuses to ping anyone without a Discord id in people.yaml", async () => {
    const { ctx, fakes } = makeTestCtx({ dryRun: false });
    await ping(ctx, ["alikhan", "stranger"]);
    expect(await approve(ctx, "D-1")).toMatch(/Can't ping stranger/);
    expect(fakes.ops).toHaveLength(0);
    expect((await ctx.db.getDecision("D-1"))?.status).toBe("failed");
  });

  it("is low risk, so it can be approved from Discord", async () => {
    const { ctx, fakes } = makeTestCtx();
    await ping(ctx, ["janedoe"]);
    expect(fakes.dms).toHaveLength(1);
  });

  it("puts the pings first and lets nothing else ping", async () => {
    const { composePost } = await import("../src/discord");
    const p = composePost("@everyone see <@999> please", ["123456789012345678", "123456789012345678", "x"]);
    expect(p.chunks[0].startsWith("<@123456789012345678>\n@everyone")).toBe(true);
    expect(p.allowed_mentions).toEqual({ parse: [], users: ["123456789012345678"] });
  });
});

describe("status formatting", () => {
  const sample = {
    phase: 1,
    dryRun: false,
    monthCents: 312,
    creditUsd: 200,
    agents: [
      { name: "ada", title: "Chief of Staff", state: "active", tasks: 1, decisions: 0, weekCents: 142, last: { at: "2026-10-31 20:15:03", line: "Assigned T-4 to Mira" } },
      { name: "mira", title: "Maintainer Desk", state: "paused", tasks: 2, decisions: 1, weekCents: 170 },
    ],
  };

  it("renders Discord markdown with a block per agent", async () => {
    const { statusMarkdown } = await import("../src/status");
    const md = statusMarkdown(sample);
    expect(md.split("\n")[0]).toBe("### Agent network · Phase 1");
    expect(md).toContain("🟢 **Ada** · Chief of Staff");
    expect(md).toContain("⏸️ **Mira** · Maintainer Desk · *paused*");
    expect(md).toContain("-# 2 open tasks · 1 decision waiting · $1.70 this week");
    expect(md).toContain("-# Last report 10-31 20:15: Assigned T-4 to Mira");
    expect(md).toContain("$3.12 of $200 credits this month (2%)");
  });

  it("keeps the Telegram text as it was", async () => {
    const { statusPlain } = await import("../src/status");
    expect(statusPlain(sample).split("\n")[1]).toBe("Ada (Chief of Staff) · active · tasks 1 · decisions 0 · 7d $1.42");
  });

  it("stops agent-written text from pinging or breaking the layout", async () => {
    const { discordSafe } = await import("../src/status");
    expect(discordSafe("ping @everyone **now**\n# big")).toBe("ping @​everyone \\*\\*now\\*\\* \\# big");
    expect(discordSafe("x".repeat(200)).length).toBe(140);
  });

  it("renders the queue with risk markers", async () => {
    const { queueMarkdown } = await import("../src/status");
    const { ctx } = makeTestCtx();
    await handleTool(ctx, "mira", "s", "request_action", {
      kind: "github.merge", target: "accordproject/virtual-agent-org-sandbox#3", summary: "Merge docs fix", rationale: "r", risk: "low",
    });
    const md = queueMarkdown(await ctx.db.listDecisions({ status: "open" }), "-# 1 card sent to your DMs.");
    expect(md).toBe("### Decision queue · 1 waiting\n\n🟡 **D-1** · Mira · `github.merge`\n-# Merge docs fix\n\n-# 1 card sent to your DMs.");
    expect(queueMarkdown([])).toBe("### Decision queue\nNothing waiting.");
  });
});

describe("vimeo (decision 18A)", () => {
  const VIDEO = { id: "1181178573", name: "Tech WG 2026-04-08", description: null, created_time: "2026-04-08T15:00:00Z", duration: 3600, link: "https://vimeo.com/1181178573", privacy: "nobody" };
  const fakeVimeo = (opts: { failOwn?: boolean; failEdit?: boolean; failChapter?: boolean } = {}) => {
    const calls: string[] = [];
    const v = {
      calls,
      ownVideo: async (id: string) => {
        calls.push(`own ${id}`);
        if (opts.failOwn) throw new Error("Vimeo GET /me/videos/x: 404");
        return VIDEO;
      },
      addChapter: async (_id: string, title: string, secs: number) => {
        if (opts.failChapter) throw new Error("Premium required");
        calls.push(`chapter ${secs} ${title}`);
      },
      edit: async (_id: string, f: any) => {
        if (opts.failEdit && f.name) throw new Error("Vimeo PATCH 500");
        calls.push(f.privacy ? `privacy ${f.privacy.view}` : `edit ${f.name}`);
      },
    };
    return v;
  };
  const publish = (ctx: any, payload: object) =>
    handleTool(ctx, "otto", "s", "request_action", {
      kind: "vimeo.publish", target: VIDEO.link, summary: "Publish Tech WG 2026-04-08", rationale: "r", risk: "low", payload,
    });
  const PAYLOAD = {
    video_id: VIDEO.id,
    name: "Accord Project Tech WG – 2026-04-08 – Template Engine v4 & GSoC 2026 Funding",
    description: "Recording of the Accord Project Technology Working Group meeting on 8 April 2026.",
    chapters: [{ title: "Welcome", start: "00:05" }, { title: "Template Engine v4", start: "4:30" }, { title: "Too late", start: "2:00:00" }],
    make_public: true,
  };

  it("shows the title, chapters and a clear PUBLIC warning on the card", async () => {
    const { ctx, fakes } = makeTestCtx();
    await publish(ctx, PAYLOAD);
    const card = fakes.sent[0].text;
    expect(card).toContain("Title: Accord Project Tech WG – 2026-04-08");
    expect(card).toContain("Recording of the Accord Project Technology Working Group");
    expect(card).toContain("4:30  Template Engine v4");
    expect(card).toContain("⚠ Makes the video PUBLIC on Vimeo");
  });

  it("adds chapters, then the text, and makes it public last", async () => {
    const v = fakeVimeo();
    const { ctx } = makeTestCtx({ dryRun: false, vimeo: () => v as any });
    await publish(ctx, PAYLOAD);
    const res = await approve(ctx, "D-1");
    expect(v.calls).toEqual([`own ${VIDEO.id}`, "chapter 5 Welcome", "chapter 270 Template Engine v4", `edit ${PAYLOAD.name}`, "privacy anybody"]);
    expect(res).toContain("2 of 3 chapters added; now PUBLIC");
    expect(res).toContain('chapter "Too late" skipped');
  });

  it("never makes a video public if the text update fails", async () => {
    const v = fakeVimeo({ failEdit: true });
    const { ctx } = makeTestCtx({ dryRun: false, vimeo: () => v as any });
    await publish(ctx, PAYLOAD);
    expect(await approve(ctx, "D-1")).toMatch(/failed: .*PATCH 500/);
    expect(v.calls.some((c) => c.startsWith("privacy"))).toBe(false);
  });

  it("carries on without chapters when the plan doesn't support them", async () => {
    const v = fakeVimeo({ failChapter: true });
    const { ctx } = makeTestCtx({ dryRun: false, vimeo: () => v as any });
    await publish(ctx, { ...PAYLOAD, chapters: PAYLOAD.chapters.slice(0, 2) });
    expect(await approve(ctx, "D-1")).toContain("0 of 2 chapters added; now PUBLIC");
  });

  it("refuses videos the account doesn't own, and leaves privacy alone unless asked", async () => {
    const v = fakeVimeo({ failOwn: true });
    const { ctx } = makeTestCtx({ dryRun: false, vimeo: () => v as any });
    await publish(ctx, PAYLOAD);
    expect(await approve(ctx, "D-1")).toMatch(/404/);
    expect(v.calls).toEqual([`own ${VIDEO.id}`]);

    const v2 = fakeVimeo();
    const { ctx: ctx2 } = makeTestCtx({ dryRun: false, vimeo: () => v2 as any });
    await publish(ctx2, { ...PAYLOAD, make_public: false, chapters: [] });
    expect(await approve(ctx2, "D-1")).toContain("still nobody");
    expect(v2.calls.some((c) => c.startsWith("privacy"))).toBe(false);
  });

  it("keeps the Vimeo tools for Otto and pages transcripts", async () => {
    const { ctx } = makeTestCtx();
    await expect(handleTool(ctx, "mira", "s", "vimeo_transcript", { video_id: "1" })).rejects.toThrow(/not available to mira/);
    const text = Array.from({ length: 5000 }, (_, i) => `[${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}] line ${i} of the meeting`).join("\n");
    ctx.vimeo = () => ({ transcript: async () => text }) as any;
    const pages: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = JSON.parse(await handleTool(ctx, "otto", "s", "vimeo_transcript", { video_id: "1", offset }));
      expect(page.text.length).toBeLessThanOrEqual(60_000);
      expect(page.text.endsWith("of the meeting")).toBe(true); // pages end on whole lines
      pages.push(page.text);
      offset = page.next_offset;
    }
    expect(pages.length).toBe(3);
    expect(pages.join("\n")).toBe(text);
  });

  it("reads Vimeo's API shapes", async () => {
    const { Vimeo, vttToLines, toSeconds, toTimecode, isTechWg } = await import("../src/vimeo");
    expect(toSeconds("1:15")).toBe(75);
    expect(toSeconds("01:02:03")).toBe(3723);
    expect(toTimecode(3723)).toBe("01:02:03.000");
    expect(isTechWg("AP TECH WG 2026-04-01")).toBe(true);
    expect(isTechWg("Accord Project's Personal Meeting Room 2026-03-25 12:06:53")).toBe(true);
    expect(isTechWg("Concerto demo")).toBe(false);
    const vtt = "WEBVTT\n\n1\n00:00:03.000 --> 00:00:06.000\n<v Speaker 0>Welcome, everyone.\n\n2\n00:00:06.000 --> 00:00:08.000\nWelcome, everyone.\n\n3\n00:01:05.500 --> 00:01:09.000\nFirst, Template Engine v4.";
    expect(vttToLines(vtt)).toBe("[00:03] Welcome, everyone.\n[01:05] First, Template Engine v4.");

    const urls: string[] = [];
    const fake = (async (url: string) => {
      urls.push(url);
      if (url.includes("/texttracks")) return new Response(JSON.stringify({ data: [{ id: 1, type: "captions", active: true, link: "https://captions.example/t.vtt" }] }));
      if (url.endsWith("t.vtt")) return new Response(vtt);
      if (url.includes("/me/videos/")) return new Response(JSON.stringify({ uri: "/videos/42", name: "Tech WG 2026-04-08", description: null, created_time: "", duration: 60, link: "l", privacy: { view: "nobody" } }));
      return new Response(JSON.stringify({ data: [{ uri: "/videos/42", name: "Tech WG 2026-04-08", description: null, created_time: "", duration: 60, link: "l", privacy: { view: "nobody" } }] }));
    }) as unknown as typeof fetch;
    const v = new Vimeo("tok", fake);
    expect((await v.recent(5))[0]).toMatchObject({ id: "42", privacy: "nobody" });
    expect(await v.transcript("42")).toContain("[01:05] First");
    await expect(v.ownVideo("../me")).rejects.toThrow(/not a Vimeo video id/);
  });
});

describe("sessions out of budget", () => {
  it("starts fresh when the session has spent its budget", async () => {
    const { ManagedAgentsError } = await import("../src/managed");
    const { messageAgent } = await import("../src/agents");
    const { ctx, fakes } = makeTestCtx();
    const first = await messageAgent(ctx, "ada", { discord: "111111111111111111" }, "hello");
    (ctx.managed as any).sendMessage = async () => {
      throw new ManagedAgentsError(400, '{"error":{"message":"session budget reached: consumed list cost has met `budget.max_list_cost`"}}', "/sessions/x/events");
    };
    const second = await messageAgent(ctx, "ada", { discord: "111111111111111111" }, "still there?");
    expect(second).not.toBe(first);
    expect(fakes.calls.filter((c) => c.method === "createSession")).toHaveLength(2);
  });

  it("doesn't continue a conversation that has used most of its budget, or one known to be spent", async () => {
    const { messageAgent } = await import("../src/agents");
    const { ctx, fakes } = makeTestCtx(); // Ada's session budget in the fixture is 150 cents
    const first = await messageAgent(ctx, "ada", { telegram: 42 }, "hello");
    await ctx.db.updateSession(first, "idle:end_turn", 125); // 83% spent
    const second = await messageAgent(ctx, "ada", { telegram: 42 }, "next");
    expect(second).not.toBe(first);
    await ctx.db.updateSession(second, "idle:budget_reached", 10);
    const third = await messageAgent(ctx, "ada", { telegram: 42 }, "and again");
    expect(third).not.toBe(second);
    expect(fakes.calls.filter((c) => c.method === "sendMessage")).toHaveLength(0);
  });
});

describe("approval cards in one app", () => {
  const queue = (ctx: any, kind: string, risk = "low", text = "hi") =>
    handleTool(ctx, "mira", "s", "request_action", { kind, target: "accordproject/concerto#1", summary: "s", rationale: "r", risk, payload: { text } });
  const one = (o: any = {}) => makeTestCtx({ network: { ...makeTestCtx().ctx.network, approvals_app: "discord" }, ...o });

  it("sends Discord-approvable cards only to Discord", async () => {
    const { ctx, fakes } = one();
    await queue(ctx, "github.merge", "medium");
    expect(fakes.dms).toHaveLength(1);
    expect(fakes.sent).toHaveLength(0);
  });

  it("keeps high-risk cards on Telegram", async () => {
    const { ctx, fakes } = one();
    await queue(ctx, "github.merge", "high");
    expect(fakes.dms).toHaveLength(0);
    expect(fakes.sent).toHaveLength(1);
  });

  it("falls back to Telegram when Discord can't deliver", async () => {
    const { ctx, fakes } = one();
    ctx.dc = { dm: async () => { throw new Error("Discord down"); } } as any;
    await queue(ctx, "github.merge", "medium");
    expect(fakes.sent).toHaveLength(1);
  });

  it("still sends both with approvals_app: both", async () => {
    const { ctx, fakes } = makeTestCtx();
    await queue(ctx, "github.merge", "medium");
    expect(fakes.dms).toHaveLength(1);
    expect(fakes.sent).toHaveLength(1);
  });

  it("puts the full content in embeds instead of cutting it off", async () => {
    const { ctx, fakes } = one();
    const long = Array.from({ length: 100 }, (_, i) => `Line ${i}: ${"x".repeat(40)}`).join("\n"); // ~5,000 chars
    await queue(ctx, "linkedin.post", "medium", long);
    const dm = fakes.dms[0];
    expect(dm.content.length).toBeLessThanOrEqual(2000);
    expect(dm.content).not.toContain("Line 0");
    const all = dm.embeds!.map((e) => e.description).join("\n");
    expect(all).toContain("Line 0:");
    expect(all).toContain("Line 99:");
    expect(dm.embeds!.reduce((n, e) => n + e.description.length + (e.title?.length ?? 0), 0)).toBeLessThanOrEqual(6000);
  });
});

describe("CI approval for fork PRs", () => {
  const fakeGh = (files: string[], head = "abcdef1234567", runs = [{ id: 7, name: "Build", html_url: "u" }]) => {
    const approved: number[] = [];
    const gh = {
      pullFiles: async () => files,
      pull: async () => ({ head: { sha: head, repo: { full_name: "fork/concerto" } }, base: { repo: { full_name: "accordproject/concerto" } }, state: "open" }),
      runsAwaitingApproval: async () => runs,
      approveRun: async (_r: unknown, id: number) => approved.push(id),
    };
    return { gh, approved };
  };
  const ask = (ctx: any, payload: unknown = { sha: "abcdef1" }, risk = "low") =>
    handleTool(ctx, "mira", "s", "request_action", { kind: "github.approve_ci", target: "accordproject/concerto#12", summary: "Approve CI", rationale: "Reviewed: docs and a parser fix", risk, payload });

  it("approves waiting runs at once when the PR changes no CI-sensitive files", async () => {
    const { gh, approved } = fakeGh(["src/parser.ts", "test/parser.test.ts", "README.md"]);
    const { ctx, fakes } = makeTestCtx({ dryRun: false, github: async () => gh as any });
    const out = await ask(ctx);
    expect(out).toMatch(/D-1 done: Approved 1 CI run \(Build\)/);
    expect(approved).toEqual([7]);
    expect(fakes.sent).toHaveLength(0);
    expect(fakes.dms).toHaveLength(0);
    expect((await ctx.db.getDecision("D-1"))?.status).toBe("executed");
  });

  it.each([".github/workflows/ci.yml", "package.json", "packages/core/package-lock.json", "scripts/release.sh", "Cargo.toml", "src/Concerto.csproj", "Dockerfile"])(
    "queues for Matt when the PR changes %s",
    async (file) => {
      const { gh, approved } = fakeGh(["src/a.ts", file]);
      const { ctx, fakes } = makeTestCtx({ dryRun: false, github: async () => gh as any });
      const out = await ask(ctx);
      expect(out).toMatch(/Queued for Matt as D-1/);
      expect(approved).toEqual([]);
      const d = await ctx.db.getDecision("D-1");
      expect(d?.risk).toBe("high");
      expect(d?.rationale).toContain(file);
      expect(fakes.sent).toHaveLength(1);
    },
  );

  it("queues for Matt when Mira herself marks it high risk", async () => {
    const { gh, approved } = fakeGh(["src/a.ts"]);
    const { ctx } = makeTestCtx({ dryRun: false, github: async () => gh as any });
    expect(await ask(ctx, { sha: "abcdef1" }, "high")).toMatch(/Queued as D-1/);
    expect(approved).toEqual([]);
  });

  it("refuses when new commits arrived after the review", async () => {
    const { gh, approved } = fakeGh(["src/a.ts"], "9999999aaaaaa");
    const { ctx } = makeTestCtx({ dryRun: false, github: async () => gh as any });
    expect(await ask(ctx)).toMatch(/failed: PR has new commits since the review/);
    expect(approved).toEqual([]);
  });

  it("needs the reviewed sha and an in-scope PR", async () => {
    const { gh } = fakeGh(["src/a.ts"]);
    const { ctx } = makeTestCtx({ dryRun: false, github: async () => gh as any });
    await expect(ask(ctx, {})).rejects.toThrow(/payload.sha is required/);
    await expect(
      handleTool(ctx, "mira", "s", "request_action", { kind: "github.approve_ci", target: "someone/else#1", summary: "s", rationale: "r", risk: "low", payload: { sha: "abcdef1" } }),
    ).rejects.toThrow(/not in the configured repos/);
  });
});

describe("structured briefs (decision 1B)", () => {
  it("requires the brief's fields and a valid effort", async () => {
    const { ctx } = makeTestCtx();
    await expect(handleTool(ctx, "ada", "s", "assign_task", { agent: "mira", title: "t", objective: "o", output: "x", effort: "small" })).rejects.toThrow(/done_when is required/);
    await expect(handleTool(ctx, "ada", "s", "assign_task", { agent: "mira", title: "t", objective: "o", output: "x", done_when: "d", effort: "huge" })).rejects.toThrow(/effort must be/);
  });

  it("sets the session budget from the effort", async () => {
    const { ctx, fakes } = makeTestCtx();
    await handleTool(ctx, "ada", "s", "assign_task", { agent: "otto", title: "t", objective: "o", output: "x", done_when: "d", effort: "large" });
    expect((fakes.calls.find((c) => c.method === "createSession")!.args[0] as any).budgetCents).toBe(300);
  });
});

describe("review check (decision 2A)", () => {
  const strict = () => {
    const base = makeTestCtx().ctx.network;
    return makeTestCtx({ network: { ...base, review_check_required: true, model_tiers: { deep: "claude-opus-5-5", standard: "claude-sonnet-5-5" } } });
  };
  const check = (ctx: any, sid: string, lines = 40) =>
    handleTool(ctx, "mira", sid, "request_review_check", {
      target: "accordproject/concerto#12",
      sha: "abcdef1234",
      changed_lines: lines,
      draft: "src/a.ts:10 blocking high: null deref",
    });
  const merge = (ctx: any, sid: string) =>
    handleTool(ctx, "mira", sid, "request_action", { kind: "github.merge", target: "accordproject/concerto#12", summary: "Merge", rationale: "r", risk: "medium" });

  it("refuses merge proposals from the session that wrote the review", async () => {
    const { ctx } = strict();
    await expect(merge(ctx, "sesn_review")).rejects.toThrow(/come from the review check/);
  });

  it("starts a fresh session that may then propose the merge", async () => {
    const { ctx, fakes } = strict();
    const out = await check(ctx, "sesn_review");
    expect(out).toMatch(/Review check T-1 started/);
    const create = fakes.calls.find((c) => c.method === "createSession")!.args[0] as any;
    expect(create.agentId).toBe("agent_mira");
    expect(create.text).toContain("treat it as claims to verify");
    expect(create.text).toContain("null deref");
    expect(create.model).toBeUndefined();
    expect(create.budgetCents).toBe(150);
    const checkSid = Object.keys(fakes.sessions)[0];
    expect(await merge(ctx, checkSid)).toMatch(/Queued as D-1/);
  });

  it("uses the deep tier for large PRs", async () => {
    const { ctx, fakes } = strict();
    await check(ctx, "sesn_review", 650);
    const create = fakes.calls.find((c) => c.method === "createSession")!.args[0] as any;
    expect(create.model).toBe("claude-opus-5-5");
    expect(create.budgetCents).toBe(300);
  });

  it("doesn't let a check start another check", async () => {
    const { ctx, fakes } = strict();
    await check(ctx, "sesn_review");
    const checkSid = Object.keys(fakes.sessions)[0];
    await expect(check(ctx, checkSid)).rejects.toThrow(/You are the review check/);
  });

  it("leaves merges alone when the rule is off", async () => {
    const { ctx } = makeTestCtx();
    expect(await merge(ctx, "sesn_any")).toMatch(/Queued as D-1/); // review_check_required off
  });
});

describe("AGENTS.md lessons (github.docs_pr)", () => {
  it("only writes guidance files", async () => {
    const { isGuidanceFile } = await import("../src/executors");
    expect(isGuidanceFile("AGENTS.md")).toBe(true);
    expect(isGuidanceFile("packages/concerto-core/AGENTS.md")).toBe(true);
    expect(isGuidanceFile("CONTRIBUTING.md")).toBe(true);
    expect(isGuidanceFile("src/index.ts")).toBe(false);
    expect(isGuidanceFile(".github/workflows/AGENTS.md.yml")).toBe(false);
    expect(isGuidanceFile("../AGENTS.md")).toBe(false);
  });

  it("opens a PR on a new branch when approved", async () => {
    const { executeDecision } = await import("../src/executors");
    const calls: [string, string, any][] = [];
    const { GitHub } = await import("../src/github");
    const fetchImpl = (async (url: string, init: any) => {
      const path = new URL(url).pathname + new URL(url).search;
      calls.push([init.method, path, init.body ? JSON.parse(init.body) : undefined]);
      const body =
        path === "/repos/accordproject/concerto" ? { default_branch: "main" }
        : path.startsWith("/repos/accordproject/concerto/git/ref/") ? { object: { sha: "base123" } }
        : path.startsWith("/repos/accordproject/concerto/contents/") && init.method === "GET" ? { sha: "old456" }
        : path.endsWith("/pulls") ? { html_url: "https://github.com/accordproject/concerto/pull/99", number: 99 }
        : {};
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const gh = new GitHub("t", fetchImpl);
    const { ctx } = makeTestCtx({ dryRun: false, github: async () => gh });
    const d = await ctx.db.createDecision({
      agent: "mira", kind: "github.docs_pr", target: "accordproject/concerto", summary: "Lessons", rationale: "Two PRs missed X", risk: "medium",
      payload: { path: "AGENTS.md", content: "# Agents\n\n## Reviewing\n- Check café metamodel versions", title: "Add review lessons" },
    });
    ctx.network = { ...ctx.network, action_kinds: { ...ctx.network.action_kinds, "github.docs_pr": { risk: "medium", executor: "github" } } };
    const r = await executeDecision(ctx, d);
    expect(r).toEqual({ ok: true, result: "Opened https://github.com/accordproject/concerto/pull/99" });
    expect(calls.find((c) => c[1] === "/repos/accordproject/concerto/git/refs")?.[2]).toEqual({ ref: "refs/heads/agents/mira-d-1", sha: "base123" });
    const put = calls.find((c) => c[0] === "PUT")!;
    expect(put[2].sha).toBe("old456");
    expect(Buffer.from(put[2].content, "base64").toString("utf8")).toContain("café");
    expect(calls.at(-1)![2].body).toContain("needs a maintainer's review");
  });
});

describe("no duplicate replies in a conversation", () => {
  it("refuses send_to_matt when Matt is already in the conversation", async () => {
    const { ctx, fakes } = makeTestCtx();
    await ctx.db.upsertSession({ id: "sesn_chat", agent: "ada", origin: "telegram", chat_id: 42 });
    await expect(handleTool(ctx, "ada", "sesn_chat", "send_to_matt", { text: "Check-in" })).rejects.toThrow(/Matt gets your reply/);
    expect(fakes.sent).toHaveLength(0);
  });

  it("still sends from scheduled runs", async () => {
    const { ctx, fakes } = makeTestCtx();
    await ctx.db.upsertSession({ id: "sesn_dep", agent: "ada", origin: "deployment" });
    expect(await handleTool(ctx, "ada", "sesn_dep", "send_to_matt", { text: "Check-in" })).toBe("Sent.");
    expect(fakes.sent).toHaveLength(1);
  });
});

describe("message.person as a Discord DM", () => {
  const run = async (to: unknown, network?: any) => {
    const { executeDecision } = await import("../src/executors");
    const base = makeTestCtx().ctx.network;
    const { ctx, fakes } = makeTestCtx({
      dryRun: false,
      network: { ...base, action_kinds: { ...base.action_kinds, "message.person": { risk: "medium", executor: "discord_dm" } }, ...network },
    });
    const d = await ctx.db.createDecision({ agent: "otto", kind: "message.person", target: "Jane Doe", summary: "Briefing", rationale: "r", risk: "medium", payload: { to, text: "Agenda for tomorrow" } });
    return { r: await executeDecision(ctx, d), fakes };
  };

  it("DMs people listed with a Discord id", async () => {
    const { r, fakes } = await run(["janedoe"]);
    expect(r).toEqual({ ok: true, result: "Sent a Discord DM to Jane Doe" });
    expect(fakes.dms).toEqual([{ user: "123456789012345678", content: "Agenda for tomorrow" }]);
  });

  it("falls back to a manual send when someone can't be DMed", async () => {
    const { r, fakes } = await run(["samlee"]);
    expect(r.manual).toBe(true);
    expect(r.result).toMatch(/Can't DM samlee/);
    expect(fakes.dms).toHaveLength(0);
  });

  it("falls back to manual with no recipient", async () => {
    const { r } = await run(undefined);
    expect(r.manual).toBe(true);
  });
});
