import { describe, expect, it } from "vitest";
import { handleUpdate } from "../src/commands";
import { approve, stop } from "../src/controls";
import { processSession } from "../src/sessions";
import { handleTool } from "../src/tools";
import { sign, verifyWebhook } from "../src/webhookVerify";
import { NETWORK, makeTestCtx } from "./helpers";

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

  it("adds platform ids from the PEOPLE_IDS secret, by name", async () => {
    const { withPeopleIds, roleFor, resolveMentions } = await import("../src/people");
    const base = { ...NETWORK, people: [{ name: "Kim Park", roles: ["maintainer"], github: "kimpark" }] };
    const network = withPeopleIds(base, JSON.stringify({ "Kim Park": { discord: "323456789012345678", telegram: 31 }, "Nobody": { telegram: "1" } }));
    expect(network.people).toEqual([{ name: "Kim Park", roles: ["maintainer"], github: "kimpark", discord: "323456789012345678", telegram: "31" }]);
    const { ctx } = makeTestCtx({ network });
    expect(roleFor(ctx, "telegram", 31)).toBe("member");
    expect(roleFor(ctx, "telegram", 1)).toBeNull(); // not in people.yaml, so the id grants nothing
    expect(resolveMentions(ctx, ["@kimpark"]).ids).toEqual(["323456789012345678"]);
  });

  it("leaves people unchanged when PEOPLE_IDS is unset or not JSON", async () => {
    const { withPeopleIds } = await import("../src/people");
    expect(withPeopleIds(NETWORK, undefined)).toBe(NETWORK);
    expect(withPeopleIds(NETWORK, "{not json")).toBe(NETWORK);
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
    const now = 1700000000;
    expect(await verifyDiscord(pub, h(sig), body, now)).toBe(true);
    expect(await verifyDiscord(pub, h(sig), body + " ", now)).toBe(false);
    expect(await verifyDiscord(pub, h("00".repeat(64)), body, now)).toBe(false);
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
    await queue(ctx, "discord.announce", "announcements", "otto");
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
    await queue(ctx, "linkedin.post", "accordproject/virtual-agent-org-sandbox#3");
    const res = await run(ctx, click(JANE, "a:D-1"));
    expect(res.data.content).toMatch(/Only the owner/);
    expect((await ctx.db.getDecision("D-1"))?.status).toBe("open");
  });

  it("rejects through a form with an optional note", async () => {
    const { ctx } = makeTestCtx();
    await queue(ctx, "linkedin.post", "accordproject/virtual-agent-org-sandbox#3");
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

  it("registers every command for the server and the bot's DMs", async () => {
    const { commandDefinitions } = await import("../src/discordInteractions");
    for (const d of commandDefinitions(["ada"]) as any[]) {
      expect(d.contexts).toEqual([0, 1]); // GUILD, BOT_DM
      expect(d.integration_types).toEqual([0]); // installed in a server
    }
  });

  it("takes /ada from a DM with the bot", async () => {
    const { ctx, fakes } = makeTestCtx();
    const res = await run(ctx, { type: 2, user: { id: OWNER }, data: { name: "ada", options: [{ name: "message", value: "Any news?" }] } });
    expect(res.data.content).toMatch(/Sent to Ada/);
    const create = fakes.calls.find((c) => c.method === "createSession")!.args[0] as any;
    expect(create.text).toBe("Any news?");
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
    expect(fakes.sent[0].text).toContain("Posts to: #agent-ops");
    expect(fakes.sent[0].text).toContain("Pings: Ali Khan, Jane Doe");
    expect(await approve(ctx, "D-1")).toBe("D-1: Posted to #agent-ops pinging Ali Khan, Jane Doe");
    expect(fakes.ops).toEqual([{ text: "PR #3 has waited 4 days for review", ids: ["223456789012345678", "123456789012345678"] }]);
  });

  it("refuses to ping anyone without a Discord id in people.yaml", async () => {
    const { ctx, fakes } = makeTestCtx({ dryRun: false });
    await expect(ping(ctx, ["alikhan", "stranger"])).rejects.toThrow(/stranger/);
    expect(fakes.ops).toHaveLength(0);
    expect(await ctx.db.getDecision("D-1")).toBeNull();
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
      {
        name: "ada", title: "Chief of Staff", state: "active", tasks: 1, decisions: 0, weekCents: 142,
        last: { at: "2026-10-31 20:15:03", line: "Assigned T-4 to Mira", doing: ["Assigned T-4 to Mira"], blocked: [] },
      },
      { name: "mira", title: "Maintainer Desk", state: "paused", tasks: 2, decisions: 1, weekCents: 170 },
    ],
  };

  it("renders Discord status as one card per agent", async () => {
    const { statusCards } = await import("../src/status");
    const p = statusCards(sample);
    expect(p.content.split("\n")[0]).toBe("### Agent network · Phase 1");
    expect(p.content).toContain("$3.12 of $200 credits this month (2%)");
    expect(p.embeds!.map((e) => e.title)).toEqual(["🟢 Ada · Chief of Staff", "⏸️ Mira · Maintainer Desk · paused"]);
    expect(p.embeds!.map((e) => e.color)).toEqual([0x2e9e5b, 0xe0a100]);
    expect(p.embeds![0].description).toBe("1 open task · 0 decisions waiting · $1.42 this week\n\n**Last report** 10-31 20:15\n- Assigned T-4 to Mira");
    expect(p.embeds![1].description).toBe("2 open tasks · 1 decision waiting · $1.70 this week\n\nNo report yet.");
  });

  it("shows the whole report and what is blocked", async () => {
    const { statusCards, discordSafe } = await import("../src/status");
    const long = "Reviewing accordproject/concerto#1590 ".repeat(8).trim();
    const p = statusCards({
      ...sample,
      agents: [{ ...sample.agents[0], last: { at: "2026-11-01 09:00:00", line: long, doing: [long, "Triage pass"], blocked: ["Needs @mttrbrts to approve D-7"] } }],
    });
    const d = p.embeds![0].description;
    expect(d).toContain(`- ${discordSafe(long, 4096)}`);
    expect(long.length).toBeGreaterThan(140);
    expect(d).toContain("- Triage pass");
    expect(d).toContain("**Blocked**\n- Needs @\u200bmttrbrts to approve D-7");
  });

  it("keeps ten agents' cards within Discord's limits", async () => {
    const { statusCards } = await import("../src/status");
    const busy = { ...sample.agents[0], last: { at: "2026-11-01 09:00:00", line: "x", doing: ["y".repeat(3000)], blocked: ["z".repeat(3000)] } };
    const p = statusCards({ ...sample, agents: Array.from({ length: 10 }, (_, i) => ({ ...busy, name: `agent${i}` })) });
    expect(p.embeds).toHaveLength(10);
    const total = p.embeds!.reduce((n, e) => n + (e.title ?? "").length + e.description.length, 0);
    expect(total).toBeLessThanOrEqual(6000);
    expect(p.embeds!.every((e) => e.description.length <= 4096 && e.description.endsWith("…"))).toBe(true);
  });

  it("answers /status with cards, after Discord's deadline", async () => {
    const { handleInteraction } = await import("../src/discordInteractions");
    const { ctx, fakes } = makeTestCtx();
    const later: Promise<unknown>[] = [];
    const res: any = await handleInteraction(ctx, { type: 2, token: "t", user: { id: ctx.ownerDiscordId! }, data: { name: "status" } }, (p) => later.push(p));
    expect(res).toEqual({ type: 5, data: { flags: 64 } });
    await Promise.all(later);
    expect(fakes.originals[0].token).toBe("t");
    expect(fakes.originals[0].embeds!.length).toBeGreaterThan(0);
  });

  it("shows each report's age and the sessions at work", async () => {
    const { statusCards, statusPlain } = await import("../src/status");
    const s = {
      ...sample,
      asOf: "2026-11-03 20:15:03",
      agents: [{ ...sample.agents[0], live: { count: 2, since: "2026-11-03 17:10:00" } }, { ...sample.agents[1], live: { count: 1, since: "2026-11-03 20:03:00" } }],
    };
    const plain = statusPlain(s).split("\n");
    expect(plain[2]).toBe("  working now: 2 sessions, the oldest started 3h ago");
    expect(plain[3]).toBe("  last report 2026-10-31 20:15:03 (3d ago): Assigned T-4 to Mira");
    expect(plain[5]).toBe("  working now: 1 session, started 12m ago");
    const cards = statusCards(s).embeds!;
    expect(cards[0].description).toContain("**Working now** · 2 sessions, the oldest started 3h ago\n\n**Last report** 10-31 20:15 · 3d ago");
  });

  it("says how long ago, in the largest unit that reads well", async () => {
    const { ago } = await import("../src/status");
    const now = "2026-11-03 12:00:00";
    expect(ago("2026-11-03 11:59:30", now)).toBe("just now");
    expect(ago("2026-11-03 11:15:00", now)).toBe("45m ago");
    expect(ago("2026-11-02 12:00:00", now)).toBe("24h ago");
    expect(ago("2026-10-31 12:00:00", now)).toBe("3d ago");
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
      kind: "linkedin.post", target: "accordproject/virtual-agent-org-sandbox#3", summary: "Merge docs fix", rationale: "r", risk: "low",
    });
    const md = queueMarkdown(await ctx.db.listDecisions({ status: "open" }), "-# 1 card sent to your DMs.");
    expect(md).toBe("### Decision queue · 1 waiting\n\n🟡 **D-1** · Mira · `linkedin.post`\n-# Merge docs fix\n\n-# 1 card sent to your DMs.");
    expect(queueMarkdown([])).toBe("### Decision queue\nNothing waiting.");
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
    expect(r.result).toMatch(/Can't DM Sam Lee: no Discord id/);
    expect(fakes.dms).toHaveLength(0);
  });

  it("refuses to run with no recipient", async () => {
    const { r, fakes } = await run(undefined);
    expect(r).toMatchObject({ ok: false });
    expect(r.result).toMatch(/payload.to is required/);
    expect(fakes.dms).toHaveLength(0);
  });
});
