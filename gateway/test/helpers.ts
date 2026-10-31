import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DeployedConfig, NetworkConfig } from "../src/config";
import type { Ctx } from "../src/context";
import { Db } from "../src/db";
import type { Env } from "../src/env";
import type { ManagedClient } from "../src/managed";
import type { Telegram } from "../src/telegram";

/** Enough of the D1 API, backed by in-memory SQLite, to run the real queries. */
export function memoryD1(): D1Database {
  const sqlite = new Database(":memory:");
  sqlite.exec(readFileSync(fileURLToPath(new URL("../migrations/0001_init.sql", import.meta.url).href), "utf8"));
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
  sandbox_repo: "mttrbrts/virtual-agent-org-sandbox",
  repos: [],
  action_kinds: {
    "github.merge": { risk: "medium", executor: "github" },
    "github.comment": { risk: "low", executor: "github" },
    "vimeo.publish": { risk: "medium", executor: "manual" },
  },
  agents: {
    ada: { name: "ada", title: "Chief of Staff", phase: 1, requestable: ["spec.change"] },
    mira: { name: "mira", title: "Maintainer Desk", phase: 1, requestable: ["github.merge", "github.comment"] },
    otto: { name: "otto", title: "Meetings", phase: 1, requestable: ["vimeo.publish"] },
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
  calls: { method: string; args: unknown[] }[];
  events: Record<string, any[]>;
  sessions: Record<string, any>;
}

export function makeTestCtx(overrides: Partial<Ctx> = {}): { ctx: Ctx; fakes: Fakes } {
  const fakes: Fakes = { sent: [], calls: [], events: {}, sessions: {} };
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
    dryRun: true,
    ...overrides,
  };
  return { ctx, fakes };
}
