import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DeployedConfig, NetworkConfig } from "../src/config";
import type { Ctx } from "../src/context";
import { Db } from "../src/db";
import type { Env } from "../src/env";
import type { DiscordBot } from "../src/discordBot";
import type { ManagedClient } from "../src/managed";
import type { Telegram } from "../src/telegram";

/** Enough of the D1 API, backed by in-memory SQLite, to run the real queries. */
export function memoryD1(): D1Database {
  const sqlite = new Database(":memory:");
  const dir = fileURLToPath(new URL("../migrations/", import.meta.url).href);
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(dir + f, "utf8"));
  const make = (sql: string, args: unknown[] = []): any => ({
    bind: (...a: unknown[]) => make(sql, a),
    first: async () => sqlite.prepare(sql).get(...(args as any[])) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...(args as any[])) }),
    run: async () => {
      const r = sqlite.prepare(sql).run(...(args as any[]));
      return { meta: { changes: r.changes } };
    },
  });
  return { prepare: (sql: string) => make(sql) } as unknown as D1Database;
}

export const NETWORK: NetworkConfig = {
  current_phase: 1,
  timezone: "Europe/London",
  monthly_credit_usd: 200,
  sandbox_repo: "accordproject/virtual-agent-org-sandbox",
  repos: ["accordproject/concerto"],
  action_kinds: {
    "github.merge": { risk: "medium", executor: "github" },
    "github.comment": { risk: "low", executor: "github" },
    "discord.announce": { risk: "medium", executor: "discord" },
    "discord.ops": { risk: "low", executor: "discord_ops" },
    "vimeo.publish": { risk: "medium", executor: "vimeo" },
    "linkedin.post": { risk: "medium", executor: "manual" },
    "github.approve_ci": { risk: "low", executor: "github", auto: true },
  },
  discord_approval_max_risk: "medium",
  people: [
    { name: "Matt Roberts", roles: ["owner"], github: "mttrbrts", telegram: "555" },
    { name: "Jane Doe", roles: ["tsc_member"], github: "janedoe", telegram: "88", discord: "123456789012345678" },
    { name: "Sam Lee", roles: ["tsc_member", "maintainer"], maintains: ["accordproject/concerto"], github: "samlee", telegram: "66" },
    { name: "Ali Khan", roles: ["maintainer"], github: "alikhan", discord: "223456789012345678" },
  ],
  agents: {
    ada: { name: "ada", title: "Chief of Staff", phase: 1, requestable: ["spec.change"] },
    mira: { name: "mira", title: "Maintainer Desk", phase: 1, requestable: ["github.merge", "github.comment", "github.approve_ci", "discord.ops", "linkedin.post"] },
    otto: { name: "otto", title: "Meetings", phase: 1, requestable: ["vimeo.publish", "discord.announce"] },
    rosa: { name: "rosa", title: "Community", phase: 2, requestable: [] },
  },
};

export const DEPLOYED: DeployedConfig = {
  agents: {
    ada: { agent_id: "agent_ada", environment_id: "env_1", vault_ids: [], memory_store_ids: ["mem_ada", "mem_shared"], session_budget_cents: 150 },
    mira: { agent_id: "agent_mira", environment_id: "env_1", vault_ids: ["vlt_mira"], memory_store_ids: ["mem_mira"], session_budget_cents: 100 },
    otto: { agent_id: "agent_otto", environment_id: "env_1", vault_ids: [], memory_store_ids: [], session_budget_cents: 100 },
  },
  deployments: { "mira-triage": { id: "dep_mira", agent: "mira" } },
};

export interface Fakes {
  sent: { chatId: number; text: string; opts?: unknown }[];
  discord: string[];
  ops: { text: string; ids: string[] }[];
  dms: { user: string; content: string; buttons?: unknown[]; embeds?: { title?: string; description: string }[] }[];
  dcEdits: { channelId: string; messageId: string; content: string; buttons?: unknown[] }[];
  originals: { token: string; content: string }[];
  calls: { method: string; args: unknown[] }[];
  events: Record<string, any[]>;
  sessions: Record<string, any>;
}

export function makeTestCtx(overrides: Partial<Ctx> = {}): { ctx: Ctx; fakes: Fakes } {
  const fakes: Fakes = { sent: [], discord: [], ops: [], dms: [], dcEdits: [], originals: [], calls: [], events: {}, sessions: {} };
  let dmId = 0;
  const dc = {
    dm: async (user: string, p: { content: string; buttons?: unknown[]; embeds?: any[] }) => {
      fakes.dms.push({ user, ...p });
      return { channelId: `dm-${user}`, messageId: `m${++dmId}` };
    },
    edit: async (channelId: string, messageId: string, p: { content: string; buttons?: unknown[] }) => {
      fakes.dcEdits.push({ channelId, messageId, ...p });
    },
    editOriginal: async (token: string, content: string) => {
      fakes.originals.push({ token, content });
    },
  } as unknown as DiscordBot;
  let msgId = 100;
  let sesn = 0;
  const tg = {
    send: async (chatId: number, text: string, opts?: unknown) => {
      fakes.sent.push({ chatId, text, opts });
      return ++msgId;
    },
    edit: async () => undefined,
    answerCallback: async () => undefined,
  } as unknown as Telegram;

  const record = (method: string) => async (...args: unknown[]) => {
    fakes.calls.push({ method, args });
    return {};
  };
  const managed = {
    createSession: async (p: unknown) => {
      fakes.calls.push({ method: "createSession", args: [p] });
      const id = `sesn_${++sesn}`;
      fakes.sessions[id] = { id, status: "running" };
      return { id, status: "running" };
    },
    retrieveSession: async (id: string) => fakes.sessions[id],
    listEvents: async (id: string) => fakes.events[id] ?? [],
    sendMessage: record("sendMessage"),
    sendToolResult: record("sendToolResult"),
    sendToolConfirmation: record("sendToolConfirmation"),
    interrupt: record("interrupt"),
    pauseDeployment: record("pauseDeployment"),
    unpauseDeployment: record("unpauseDeployment"),
    archiveVault: record("archiveVault"),
  } as unknown as ManagedClient;

  const env = { OWNER_TELEGRAM_ID: "42", TSC_TELEGRAM_IDS: "77" } as Env;
  const ctx: Ctx = {
    env,
    db: new Db(memoryD1()),
    tg,
    managed,
    network: NETWORK,
    deployed: DEPLOYED,
    ownerChatId: 42,
    github: async () => {
      throw new Error("no github in tests");
    },
    dc,
    ownerDiscordId: "111111111111111111",
    discord: {
      configured: true,
      post: async (text: string) => {
        fakes.discord.push(text);
        return 1;
      },
    },
    discordOps: {
      configured: true,
      post: async (text: string, ids: string[]) => {
        fakes.ops.push({ text, ids });
        return 1;
      },
    },
    vimeo: () => {
      throw new Error("no vimeo in tests");
    },
    dryRun: true,
    ...overrides,
  };
  return { ctx, fakes };
}
