// The gateway's edges and runtime: request authentication, configuration checks,
// tool-call idempotency, the sweeper and retention, and the approve_ci workflow check.

import { describe, expect, it } from "vitest";
import { Db } from "../src/db";
import { verifyDiscord } from "../src/discordBot";
import { checkEnv, type Env } from "../src/env";
import worker from "../src/index";
import { ciApprovalRisks, ciSensitivePaths } from "../src/review";
import { housekeeping, processSession, sweep } from "../src/sessions";
import { timingSafeEqual } from "../src/webhookVerify";
import { workflowWarnings } from "../src/workflows";
import { SAFE_WORKFLOW, fakeGitHub, makeTestCtx, memoryD1 } from "./helpers";

const GOOD_ENV = {
  TELEGRAM_BOT_TOKEN: "123:abc",
  TELEGRAM_WEBHOOK_SECRET: "tg-secret-value",
  OWNER_TELEGRAM_ID: "42",
  ANTHROPIC_API_KEY: "sk-ant-test",
  ANTHROPIC_WEBHOOK_SECRET: "whsec_" + btoa("0123456789abcdef0123456789abcdef"),
};

function workerEnv(over: Partial<Env> = {}): Env {
  return { DB: memoryD1(), ...GOOD_ENV, ...over } as Env;
}

function exec() {
  const pending: Promise<unknown>[] = [];
  return { pending, ctx: { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => undefined } as unknown as ExecutionContext };
}

const telegram = (secret?: string) =>
  new Request("https://gw.example/telegram", {
    method: "POST",
    headers: secret === undefined ? {} : { "x-telegram-bot-api-secret-token": secret },
    body: "{}",
  });

describe("Telegram webhook secret", () => {
  it("accepts only the exact secret, and refuses a missing header", async () => {
    const env = workerEnv();
    expect((await worker.fetch(telegram(), env, exec().ctx)).status).toBe(403);
    expect((await worker.fetch(telegram("tg-secret-valuX"), env, exec().ctx)).status).toBe(403);
    expect((await worker.fetch(telegram("tg-secret"), env, exec().ctx)).status).toBe(403);
    const e = exec();
    expect((await worker.fetch(telegram("tg-secret-value"), env, e.ctx)).status).toBe(200);
    await Promise.all(e.pending);
  });

  it("compares in constant time over strings of equal length", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });
});

describe("Discord interaction replay window", () => {
  it("refuses a correctly signed interaction more than five minutes old or ahead", async () => {
    const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const pub = Buffer.from(await crypto.subtle.exportKey("raw", kp.publicKey)).toString("hex");
    const body = '{"type":1}';
    const ts = "1700000000";
    const sig = Buffer.from(await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(ts + body))).toString("hex");
    const h = new Headers({ "x-signature-ed25519": sig, "x-signature-timestamp": ts });
    const now = Number(ts);
    expect(await verifyDiscord(pub, h, body, now + 299)).toBe(true);
    expect(await verifyDiscord(pub, h, body, now + 301)).toBe(false);
    expect(await verifyDiscord(pub, h, body, now - 301)).toBe(false);
    const bad = new Headers({ "x-signature-ed25519": sig, "x-signature-timestamp": "17e8" });
    expect(await verifyDiscord(pub, bad, body, now)).toBe(false);
  });
});

describe("configuration check", () => {
  it("names missing or malformed secrets without their values", () => {
    expect(checkEnv(GOOD_ENV)).toEqual([]);
    const problems = checkEnv({ ...GOOD_ENV, ANTHROPIC_API_KEY: "", OWNER_TELEGRAM_ID: "@matt", TELEGRAM_WEBHOOK_SECRET: undefined });
    expect(problems).toEqual(["TELEGRAM_WEBHOOK_SECRET is not set", "ANTHROPIC_API_KEY is not set", "OWNER_TELEGRAM_ID is not a numeric Telegram id"]);
    expect(problems.join(" ")).not.toContain("@matt");
  });

  it("reports on /health and fails every other route closed", async () => {
    const env = workerEnv({ ANTHROPIC_WEBHOOK_SECRET: "" });
    const health = await worker.fetch(new Request("https://gw.example/health"), env, exec().ctx);
    expect(health.status).toBe(503);
    const text = await health.text();
    expect(text).toContain("ANTHROPIC_WEBHOOK_SECRET is not set");
    expect(text).not.toContain(GOOD_ENV.ANTHROPIC_API_KEY);
    expect((await worker.fetch(telegram("tg-secret-value"), env, exec().ctx)).status).toBe(503);
    expect((await worker.fetch(new Request("https://gw.example/anthropic", { method: "POST", body: "{}" }), env, exec().ctx)).status).toBe(503);
    expect((await worker.fetch(new Request("https://gw.example/health"), workerEnv(), exec().ctx)).status).toBe(200);
  });

  it("makes the cron audit the problem and do nothing else", async () => {
    const d1 = memoryD1();
    const e = exec();
    await worker.scheduled({} as ScheduledController, workerEnv({ DB: d1, OWNER_TELEGRAM_ID: "" }), e.ctx);
    await Promise.all(e.pending);
    const row = await d1.prepare("SELECT event_type, detail FROM audit").first<{ event_type: string; detail: string }>();
    expect(row?.event_type).toBe("gateway.misconfigured");
    expect(row?.detail).toContain("OWNER_TELEGRAM_ID is not set");
  });
});

describe("tool-call idempotency", () => {
  it("runs a tool once and resends its stored answer when the first send fails", async () => {
    const { ctx, fakes } = makeTestCtx();
    let failures = 1;
    (ctx.managed as any).sendToolResult = async (...args: unknown[]) => {
      if (failures-- > 0) throw new Error("Managed Agents 503 on /sessions/s1/events");
      fakes.calls.push({ method: "sendToolResult", args });
    };
    fakes.sessions.s1 = { id: "s1", status: "idle", agent: { id: "agent_ada" }, stop_reason: { type: "requires_action" } };
    await ctx.db.upsertSession({ id: "s1", agent: "ada", origin: "task" });
    fakes.events.s1 = [{ id: "e1", type: "agent.custom_tool_use", name: "send_to_matt", input: { text: "hello" } }];

    await processSession(ctx, "s1"); // the tool runs; the send fails
    await processSession(ctx, "s1"); // the retry resends the stored answer

    expect(fakes.sent.filter((s) => s.text === "hello")).toHaveLength(1);
    const sends = fakes.calls.filter((c) => c.method === "sendToolResult");
    expect(sends).toHaveLength(1);
    expect(sends[0].args).toEqual(["s1", "e1", "Sent."]);
  });

  it("doesn't re-run handled events after their claims are pruned", async () => {
    const d1 = memoryD1();
    const { ctx, fakes } = makeTestCtx({ db: new Db(d1) });
    fakes.sessions.s1 = { id: "s1", status: "idle", agent: { id: "agent_ada" }, stop_reason: { type: "end_turn" } };
    await ctx.db.upsertSession({ id: "s1", agent: "ada", origin: "task" });
    fakes.events.s1 = [
      { id: "e1", type: "agent.custom_tool_use", name: "send_to_matt", input: { text: "one" } },
      { id: "e2", type: "agent.custom_tool_use", name: "send_to_matt", input: { text: "two" } },
    ];
    await processSession(ctx, "s1");
    expect(await ctx.db.eventsDoneThrough("s1")).toBe("e2");

    await d1.prepare("DELETE FROM processed_events").run();
    await d1.prepare("DELETE FROM tool_results").run();
    fakes.events.s1.push({ id: "e3", type: "agent.custom_tool_use", name: "send_to_matt", input: { text: "three" } });
    await processSession(ctx, "s1");

    expect(fakes.sent.map((s) => s.text)).toEqual(["one", "two", "three"]);
    expect(await ctx.db.eventsDoneThrough("s1")).toBe("e3");
  });

  it("keeps the bookmark before an event another pass may still be handling", async () => {
    const d1 = memoryD1();
    const { ctx, fakes } = makeTestCtx({ db: new Db(d1) });
    fakes.sessions.s1 = { id: "s1", status: "running", agent: { id: "agent_ada" } };
    await ctx.db.upsertSession({ id: "s1", agent: "ada", origin: "task" });
    fakes.events.s1 = [
      { id: "e1", type: "agent.custom_tool_use", name: "send_to_matt", input: { text: "one" } },
      { id: "e2", type: "agent.custom_tool_use", name: "send_to_matt", input: { text: "two" } },
    ];
    await ctx.db.claimEvent("e1"); // a concurrent pass is handling e1
    await processSession(ctx, "s1");
    expect(fakes.sent.map((s) => s.text)).toEqual(["two"]);
    expect(await ctx.db.eventsDoneThrough("s1")).toBeNull();

    await ctx.db.markEventDone("e1"); // the other pass finished it
    await processSession(ctx, "s1");
    expect(await ctx.db.eventsDoneThrough("s1")).toBe("e2");
    expect(fakes.sent.map((s) => s.text)).toEqual(["two"]);
  });

  it("moves past a claim that was never marked done once it is old enough", async () => {
    const d1 = memoryD1();
    const { ctx, fakes } = makeTestCtx({ db: new Db(d1) });
    fakes.sessions.s1 = { id: "s1", status: "running", agent: { id: "agent_ada" } };
    await ctx.db.upsertSession({ id: "s1", agent: "ada", origin: "task" });
    fakes.events.s1 = [{ id: "e1", type: "agent.custom_tool_use", name: "send_to_matt", input: { text: "one" } }];
    await ctx.db.claimEvent("e1");
    await processSession(ctx, "s1");
    expect(await ctx.db.eventsDoneThrough("s1")).toBeNull();
    await d1.prepare("UPDATE processed_events SET ts = datetime('now', '-10 minutes') WHERE event_id = 'e1'").run();
    await processSession(ctx, "s1");
    expect(await ctx.db.eventsDoneThrough("s1")).toBe("e1");
    expect(fakes.sent).toEqual([]);
  });
});

describe("session budget alert", () => {
  it("tells Matt once, however often the session is processed", async () => {
    const { ctx, fakes } = makeTestCtx();
    fakes.sessions.sb = { id: "sb", status: "idle", agent: { id: "agent_mira" }, stop_reason: { type: "budget_reached" } };
    await ctx.db.upsertSession({ id: "sb", agent: "mira", origin: "task" });
    await sweep(ctx);
    await sweep(ctx);
    await processSession(ctx, "sb"); // a late webhook
    expect(fakes.sent.filter((s) => s.text.includes("hit its session budget"))).toHaveLength(1);
  });
});

describe("sweeper and retention", () => {
  it("sweeps at most the limit, least recently updated first", async () => {
    const d1 = memoryD1();
    const { ctx, fakes } = makeTestCtx({ db: new Db(d1) });
    const seen: string[] = [];
    (ctx.managed as any).retrieveSession = async (id: string) => {
      seen.push(id);
      return fakes.sessions[id];
    };
    for (let i = 0; i < 45; i++) {
      fakes.sessions[`s${i}`] = { id: `s${i}`, status: "running", agent: { id: "agent_mira" } };
      await ctx.db.upsertSession({ id: `s${i}`, agent: "mira", origin: "task" });
    }
    await d1.prepare("UPDATE sessions SET updated_at = datetime('now', '-1 day') WHERE id = 's44'").run();
    await ctx.db.upsertSession({ id: "done", agent: "mira", origin: "task", status: "idle:end_turn" });

    await sweep(ctx);
    expect(seen).toHaveLength(40);
    expect(seen[0]).toBe("s44");
    expect(seen).not.toContain("done");
  });

  it("marks idle sessions untouched for a week as stale and prunes old rows", async () => {
    const d1 = memoryD1();
    const { ctx } = makeTestCtx({ db: new Db(d1) });
    const at = (id: string, status: string, age: string) =>
      d1.prepare(`INSERT INTO sessions (id, agent, origin, status, updated_at) VALUES (?, 'mira', 'task', ?, datetime('now', ?))`).bind(id, status, age).run();
    await at("old_idle", "idle:end_turn", "-8 days");
    await at("new_idle", "idle:end_turn", "-1 day");
    await at("old_running", "running", "-8 days");
    for (const [id, age] of [["wh:old", "-20 days"], ["wh:new", "-1 day"]]) {
      await d1.prepare("INSERT INTO processed_events (event_id, ts) VALUES (?, datetime('now', ?))").bind(id, age).run();
      await d1.prepare("INSERT INTO tool_results (event_id, result, created_at) VALUES (?, 'ok', datetime('now', ?))").bind(id, age).run();
    }
    await d1.prepare("INSERT INTO audit (event_type, ts) VALUES ('old', datetime('now', '-400 days'))").run();
    await d1.prepare("INSERT INTO audit (event_type, ts) VALUES ('recent', datetime('now', '-300 days'))").run();

    await housekeeping(ctx);

    const statuses = (await d1.prepare("SELECT id, status FROM sessions ORDER BY id").all<{ id: string; status: string }>()).results;
    expect(Object.fromEntries(statuses.map((s) => [s.id, s.status]))).toEqual({ new_idle: "idle:end_turn", old_idle: "stale", old_running: "running" });
    const ids = async (sql: string) => (await d1.prepare(sql).all<{ id: string }>()).results.map((r) => r.id);
    expect(await ids("SELECT event_id AS id FROM processed_events")).toEqual(["wh:new"]);
    expect(await ids("SELECT event_id AS id FROM tool_results")).toEqual(["wh:new"]);
    expect(await ids("SELECT event_type AS id FROM audit ORDER BY rowid")).toEqual(["recent", "gateway.housekeeping"]);
  });
});

describe("approve_ci safety", () => {
  it("treats build, runner and tool configuration as CI-sensitive", () => {
    const sensitive = [
      "pom.xml", "sub/build.gradle.kts", "settings.gradle", "gradlew", "gradle/wrapper/gradle-wrapper.properties",
      "tests/conftest.py", "tox.ini", "noxfile.py", "setup.cfg", "tsconfig.json", "packages/a/tsconfig.build.json",
      "jest.config.js", "vitest.config.mts", "packages/x/eslint.config.cjs", ".gitmodules", ".nvmrc", ".node-version",
      ".tool-versions", ".devcontainer/devcontainer.json",
    ];
    expect(ciSensitivePaths([...sensitive, "src/parser.ts", "test/parser.test.ts", "docs/config.md"])).toEqual(sensitive);
  });

  it("warns about workflow_run and secrets in pull_request workflows", () => {
    expect(workflowWarnings("on:\n  workflow_run:\n    workflows: [ci]\njobs: {}\n")).toEqual([
      "uses workflow_run, which runs with the repo's secrets after other workflows",
    ]);
    const pr = (step: string) => `on: [pull_request]\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - ${step}\n`;
    expect(workflowWarnings(pr("run: echo ${{ secrets.NPM_TOKEN }}"))).toEqual(["pull_request workflow uses secrets (NPM_TOKEN)"]);
    expect(workflowWarnings(pr("run: echo ${{ secrets.GITHUB_TOKEN }}"))).toEqual([]);
    expect(workflowWarnings(pr("run: npm test # secrets.NPM_TOKEN isn't needed"))).toEqual([]);
    expect(workflowWarnings("on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ${{ secrets.NPM_TOKEN }}\n")).toEqual([]);
  });

  it("finds nothing in an ordinary repo, names risky workflows, and fails closed when it can't read them", async () => {
    const ref = { owner: "accordproject", repo: "concerto" };
    expect(await ciApprovalRisks(fakeGitHub() as any, ref)).toEqual([]);

    const target = { path: ".github/workflows/label.yml", text: "on: pull_request_target\njobs:\n  l:\n    runs-on: self-hosted\n" };
    expect(await ciApprovalRisks(fakeGitHub({ workflows: [SAFE_WORKFLOW, target] }) as any, ref)).toEqual([
      ".github/workflows/label.yml: uses pull_request_target",
      ".github/workflows/label.yml: job l runs on self-hosted, not a GitHub-hosted runner",
    ]);

    const [reason] = await ciApprovalRisks(fakeGitHub({ workflows: null }) as any, ref);
    expect(reason).toMatch(/^couldn't read the repo's workflows/);
  });
});
