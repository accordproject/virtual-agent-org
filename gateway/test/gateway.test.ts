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
    await expect(handleTool(ctx, "ada", "s", "assign_task", { agent: "rosa", title: "t", brief: "b" })).rejects.toThrow(/phase 2/);
  });

  it("assigns a task by starting a session for the agent", async () => {
    const { ctx, fakes } = makeTestCtx();
    const out = await handleTool(ctx, "ada", "s", "assign_task", { agent: "mira", title: "Triage", brief: "Do it" });
    expect(out).toBe("Assigned T-1 to Mira.");
    const create = fakes.calls.find((c) => c.method === "createSession")!.args[0] as any;
    expect(create.agentId).toBe("agent_mira");
    expect(create.text).toContain("Task T-1");
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
    await queue(ctx, "vimeo.publish", "vimeo:123", { text: "Title and chapters" });
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
      const { postToDiscord } = await import("../src/discord");
      await expect(new Telegram("t").send(1, "hi")).resolves.toBe(1);
      await expect(new ManagedClient("k").retrieveSession("s")).resolves.toBeDefined();
      await expect(postToDiscord("https://discord.com/api/webhooks/1/a", "hi")).resolves.toBe(1);
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

  it("posts the approved text to the webhook", async () => {
    const { ctx, fakes } = makeTestCtx({ dryRun: false });
    await queueAnnounce(ctx);
    expect(await approve(ctx, "D-1")).toBe("D-1: Posted to Discord");
    expect(fakes.discord).toEqual(["Tech WG summary"]);
    expect((await ctx.db.getDecision("D-1"))?.status).toBe("executed");
  });

  it("falls back to manual posting when no webhook is set", async () => {
    const { ctx, fakes } = makeTestCtx({ dryRun: false });
    ctx.discord = { configured: false, post: async () => 0 };
    await queueAnnounce(ctx);
    expect(await approve(ctx, "D-1")).toContain("Mark done");
    expect(fakes.discord).toHaveLength(0);
    expect((await ctx.db.getDecision("D-1"))?.status).toBe("approved");
  });

  it("only labels, never pings, and splits long posts", async () => {
    const { postToDiscord, withLabel, AGENT_LABEL } = await import("../src/discord");
    const bodies: any[] = [];
    const urls: string[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      urls.push(url);
      bodies.push(JSON.parse(String(init.body)));
      return new Response("{}");
    }) as unknown as typeof fetch;
    const hook = "https://discord.com/api/webhooks/123/abc-DEF_1";
    const long = Array.from({ length: 120 }, (_, i) => `line ${i} @everyone`.padEnd(40, ".")).join("\n");
    const n = await postToDiscord(hook, long, fake);
    expect(n).toBeGreaterThan(1);
    expect(bodies.every((b) => b.content.length <= 2000 && b.allowed_mentions.parse.length === 0)).toBe(true);
    expect(urls.every((u) => u === `${hook}?wait=true`)).toBe(true);
    expect(bodies.at(-1).content).toContain(AGENT_LABEL);
    expect(withLabel(`Hi\n\n${AGENT_LABEL}`).match(new RegExp(AGENT_LABEL, "g"))).toHaveLength(1);
    await expect(postToDiscord("https://evil.example/hook", "x", fake)).rejects.toThrow(/not a Discord webhook/);
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
