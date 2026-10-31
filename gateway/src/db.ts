// Data access for the gateway's D1 database.

export type DecisionStatus = "open" | "approved" | "rejected" | "executed" | "failed";
export type AgentStatus = "active" | "paused" | "stopped" | "revoked";

export interface Decision {
  id: string;
  seq: number;
  agent: string;
  kind: string;
  target: string;
  summary: string;
  rationale: string;
  risk: string;
  payload: string;
  status: DecisionStatus;
  note: string | null;
  result: string | null;
  session_id: string | null;
  tool_use_id: string | null;
  tg_message_id: number | null;
  discord_channel_id: string | null;
  discord_message_id: string | null;
  created_at: string;
  decided_at: string | null;
  executed_at: string | null;
}

export interface Task {
  id: string;
  agent: string;
  title: string;
  brief: string;
  priority: string;
  due: string | null;
  status: string;
  session_id: string | null;
  created_at: string;
}

export interface SessionRow {
  id: string;
  agent: string;
  origin: "telegram" | "discord" | "task" | "deployment";
  chat_id: number | null;
  discord_user: string | null;
  task_id: string | null;
  status: string;
  cost_cents: number;
}

export class Db {
  constructor(private db: D1Database) {}

  // ---- counters -----------------------------------------------------------

  async next(counter: "decision" | "task"): Promise<number> {
    const row = await this.db
      .prepare("UPDATE counters SET value = value + 1 WHERE name = ? RETURNING value")
      .bind(counter)
      .first<{ value: number }>();
    if (!row) throw new Error(`counter ${counter} missing`);
    return row.value;
  }

  // ---- agents -------------------------------------------------------------

  async agentStatus(name: string): Promise<AgentStatus> {
    const row = await this.db.prepare("SELECT status FROM agents WHERE name = ?").bind(name).first<{ status: AgentStatus }>();
    return row?.status ?? "active";
  }

  async setAgentStatus(name: string, status: AgentStatus) {
    await this.db
      .prepare(
        "INSERT INTO agents (name, status, updated_at) VALUES (?, ?, datetime('now')) " +
          "ON CONFLICT(name) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at",
      )
      .bind(name, status)
      .run();
  }

  async allAgentStatuses(): Promise<Record<string, AgentStatus>> {
    const { results } = await this.db.prepare("SELECT name, status FROM agents").all<{ name: string; status: AgentStatus }>();
    return Object.fromEntries(results.map((r) => [r.name, r.status]));
  }

  // ---- sessions -----------------------------------------------------------

  async upsertSession(s: Partial<SessionRow> & { id: string; agent: string; origin: SessionRow["origin"] }) {
    await this.db
      .prepare(
        "INSERT INTO sessions (id, agent, origin, chat_id, discord_user, task_id, status) VALUES (?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO NOTHING",
      )
      .bind(s.id, s.agent, s.origin, s.chat_id ?? null, s.discord_user ?? null, s.task_id ?? null, s.status ?? "running")
      .run();
  }

  getSession(id: string) {
    return this.db.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
  }

  async updateSession(id: string, status: string, costCents: number) {
    await this.db
      .prepare("UPDATE sessions SET status = ?, cost_cents = MAX(cost_cents, ?), updated_at = datetime('now') WHERE id = ?")
      .bind(status, costCents, id)
      .run();
  }

  async activeSessions(agent?: string): Promise<SessionRow[]> {
    const sql =
      "SELECT * FROM sessions WHERE status NOT IN ('terminated', 'done')" + (agent ? " AND agent = ?" : "");
    const stmt = agent ? this.db.prepare(sql).bind(agent) : this.db.prepare(sql);
    return (await stmt.all<SessionRow>()).results;
  }

  /** The latest Telegram conversation with an agent, if it is recent enough to continue. */
  recentChatSession(agent: string, chatId: number, maxAgeHours = 6) {
    return this.db
      .prepare(
        "SELECT * FROM sessions WHERE agent = ? AND origin = 'telegram' AND chat_id = ? " +
          "AND status NOT IN ('terminated') AND updated_at > datetime('now', ?) ORDER BY updated_at DESC, rowid DESC LIMIT 1",
      )
      .bind(agent, chatId, `-${maxAgeHours} hours`)
      .first<SessionRow>();
  }

  /** The latest Discord conversation with an agent, if it is recent enough to continue. */
  recentDiscordSession(agent: string, discordUser: string, maxAgeHours = 6) {
    return this.db
      .prepare(
        "SELECT * FROM sessions WHERE agent = ? AND origin = 'discord' AND discord_user = ? " +
          "AND status NOT IN ('terminated') AND updated_at > datetime('now', ?) ORDER BY updated_at DESC, rowid DESC LIMIT 1",
      )
      .bind(agent, discordUser, `-${maxAgeHours} hours`)
      .first<SessionRow>();
  }

  async spendByAgent(sinceIso: string): Promise<Record<string, number>> {
    const { results } = await this.db
      .prepare("SELECT agent, SUM(cost_cents) AS cents FROM sessions WHERE created_at >= ? GROUP BY agent")
      .bind(sinceIso)
      .all<{ agent: string; cents: number }>();
    return Object.fromEntries(results.map((r) => [r.agent, r.cents]));
  }

  // ---- events: idempotency ------------------------------------------------

  /** Returns true the first time an event id is claimed. */
  async claimEvent(eventId: string): Promise<boolean> {
    const r = await this.db.prepare("INSERT OR IGNORE INTO processed_events (event_id) VALUES (?)").bind(eventId).run();
    return (r.meta?.changes ?? 0) > 0;
  }

  async releaseEvent(eventId: string) {
    await this.db.prepare("DELETE FROM processed_events WHERE event_id = ?").bind(eventId).run();
  }

  // ---- decisions ----------------------------------------------------------

  async createDecision(d: {
    agent: string;
    kind: string;
    target: string;
    summary: string;
    rationale: string;
    risk: string;
    payload?: unknown;
    session_id?: string;
    tool_use_id?: string;
  }): Promise<Decision> {
    const seq = await this.next("decision");
    const id = `D-${seq}`;
    await this.db
      .prepare(
        "INSERT INTO decisions (id, seq, agent, kind, target, summary, rationale, risk, payload, session_id, tool_use_id) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        id,
        seq,
        d.agent,
        d.kind,
        d.target,
        d.summary,
        d.rationale,
        d.risk,
        JSON.stringify(d.payload ?? {}),
        d.session_id ?? null,
        d.tool_use_id ?? null,
      )
      .run();
    return (await this.getDecision(id))!;
  }

  getDecision(id: string) {
    return this.db.prepare("SELECT * FROM decisions WHERE id = ?").bind(id.toUpperCase()).first<Decision>();
  }

  async listDecisions(filter: { status?: "open" | "decided" | "all"; agent?: string } = {}): Promise<Decision[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.status === "open") where.push("status = 'open'");
    if (filter.status === "decided") where.push("status != 'open'");
    if (filter.agent) {
      where.push("agent = ?");
      args.push(filter.agent);
    }
    const sql =
      "SELECT * FROM decisions" + (where.length ? ` WHERE ${where.join(" AND ")}` : "") + " ORDER BY seq ASC LIMIT 200";
    return (await this.db.prepare(sql).bind(...args).all<Decision>()).results;
  }

  /** Moves an open decision to approved/rejected. Returns false if it was not open. */
  async decide(id: string, status: "approved" | "rejected", note?: string): Promise<boolean> {
    const r = await this.db
      .prepare("UPDATE decisions SET status = ?, note = ?, decided_at = datetime('now') WHERE id = ? AND status = 'open'")
      .bind(status, note ?? null, id.toUpperCase())
      .run();
    return (r.meta?.changes ?? 0) > 0;
  }

  async setNote(id: string, note: string) {
    await this.db.prepare("UPDATE decisions SET note = ? WHERE id = ?").bind(note, id.toUpperCase()).run();
  }

  async markExecuted(id: string, ok: boolean, result: string) {
    await this.db
      .prepare("UPDATE decisions SET status = ?, result = ?, executed_at = datetime('now') WHERE id = ?")
      .bind(ok ? "executed" : "failed", result, id.toUpperCase())
      .run();
  }

  async setDiscordMessage(id: string, channelId: string, messageId: string) {
    await this.db
      .prepare("UPDATE decisions SET discord_channel_id = ?, discord_message_id = ? WHERE id = ?")
      .bind(channelId, messageId, id)
      .run();
  }

  async setDecisionMessage(id: string, messageId: number) {
    await this.db.prepare("UPDATE decisions SET tg_message_id = ? WHERE id = ?").bind(messageId, id).run();
  }

  // ---- tasks --------------------------------------------------------------

  async createTask(t: { agent: string; title: string; brief: string; priority?: string; due?: string }): Promise<Task> {
    const seq = await this.next("task");
    const id = `T-${seq}`;
    await this.db
      .prepare("INSERT INTO tasks (id, seq, agent, title, brief, priority, due) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, seq, t.agent, t.title, t.brief, t.priority ?? "normal", t.due ?? null)
      .run();
    return (await this.db.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first<Task>())!;
  }

  async setTask(id: string, status: string, sessionId?: string) {
    await this.db
      .prepare("UPDATE tasks SET status = ?, session_id = COALESCE(?, session_id), updated_at = datetime('now') WHERE id = ?")
      .bind(status, sessionId ?? null, id)
      .run();
  }

  async openTasks(agent?: string): Promise<Task[]> {
    const sql = "SELECT * FROM tasks WHERE status IN ('open', 'running')" + (agent ? " AND agent = ?" : "") + " ORDER BY seq";
    const stmt = agent ? this.db.prepare(sql).bind(agent) : this.db.prepare(sql);
    return (await stmt.all<Task>()).results;
  }

  // ---- statuses, scorecards, evaluations ----------------------------------

  async addStatus(s: { agent: string; session_id: string; done: string[]; doing: string[]; blocked: string[]; notes?: string }) {
    await this.db
      .prepare("INSERT INTO statuses (agent, session_id, done, doing, blocked, notes) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(s.agent, s.session_id, JSON.stringify(s.done), JSON.stringify(s.doing), JSON.stringify(s.blocked), s.notes ?? null)
      .run();
  }

  async latestStatuses(agent?: string) {
    const sql =
      "SELECT s.* FROM statuses s JOIN (SELECT agent, MAX(id) AS id FROM statuses GROUP BY agent) m ON s.id = m.id" +
      (agent ? " WHERE s.agent = ?" : "");
    const stmt = agent ? this.db.prepare(sql).bind(agent) : this.db.prepare(sql);
    return (
      await stmt.all<{ agent: string; done: string; doing: string; blocked: string; notes: string | null; created_at: string }>()
    ).results.map((r) => ({
      agent: r.agent,
      at: r.created_at,
      done: JSON.parse(r.done) as string[],
      doing: JSON.parse(r.doing) as string[],
      blocked: JSON.parse(r.blocked) as string[],
      notes: r.notes,
    }));
  }

  async putScorecard(period: string, body: unknown) {
    await this.db
      .prepare("INSERT INTO scorecards (period, body) VALUES (?, ?) ON CONFLICT(period) DO UPDATE SET body = excluded.body, created_at = datetime('now')")
      .bind(period, JSON.stringify(body))
      .run();
  }

  async getScorecard(period?: string) {
    const row = period
      ? await this.db.prepare("SELECT * FROM scorecards WHERE period = ?").bind(period).first<{ period: string; body: string }>()
      : await this.db.prepare("SELECT * FROM scorecards ORDER BY created_at DESC LIMIT 1").first<{ period: string; body: string }>();
    return row ? { period: row.period, scorecard: JSON.parse(row.body) } : null;
  }

  async putEvaluation(e: { agent: string; week: string; scores: unknown; evidence: string; proposal?: string }) {
    await this.db
      .prepare(
        "INSERT INTO evaluations (agent, week, scores, evidence, proposal) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(agent, week) DO UPDATE SET scores = excluded.scores, evidence = excluded.evidence, proposal = excluded.proposal",
      )
      .bind(e.agent, e.week, JSON.stringify(e.scores), e.evidence, e.proposal ?? null)
      .run();
  }

  // ---- audit and telegram state -------------------------------------------

  async audit(a: {
    agent?: string;
    session_id?: string;
    event_id?: string;
    event_type: string;
    tool?: string;
    permission?: string;
    detail?: unknown;
  }) {
    await this.db
      .prepare("INSERT INTO audit (agent, session_id, event_id, event_type, tool, permission, detail) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(
        a.agent ?? null,
        a.session_id ?? null,
        a.event_id ?? null,
        a.event_type,
        a.tool ?? null,
        a.permission ?? null,
        a.detail === undefined ? null : JSON.stringify(a.detail).slice(0, 4000),
      )
      .run();
  }

  async addPendingReply(messageId: number, chatId: number, kind: string, ref: string) {
    await this.db
      .prepare("INSERT OR REPLACE INTO pending_replies (message_id, chat_id, kind, ref) VALUES (?, ?, ?, ?)")
      .bind(messageId, chatId, kind, ref)
      .run();
  }

  async takePendingReply(messageId: number) {
    const row = await this.db
      .prepare("SELECT * FROM pending_replies WHERE message_id = ?")
      .bind(messageId)
      .first<{ kind: string; ref: string; chat_id: number }>();
    if (row) await this.db.prepare("DELETE FROM pending_replies WHERE message_id = ?").bind(messageId).run();
    return row;
  }
}
