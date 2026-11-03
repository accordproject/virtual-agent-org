// Network status, gathered once and rendered for each app:
// plain text for Telegram, Discord cards for Discord.

import { cap, type Ctx } from "./context";
import type { Decision } from "./db";
import type { DiscordPayload } from "./discordBot";
import { processSession } from "./sessions";

export interface AgentStatusRow {
  name: string;
  title: string;
  state: string; // active | paused | stopped | revoked | not deployed
  tasks: number;
  /** How many of those tasks ended blocked and wait on a follow-up. */
  blockedTasks?: number;
  decisions: number;
  weekCents: number;
  /** Sessions at work now, and when the oldest of them started. */
  live?: { count: number; since: string };
  last?: { at: string; line: string; doing: string[]; blocked: string[] };
}

export interface NetworkStatus {
  phase: number;
  dryRun: boolean;
  agents: AgentStatusRow[];
  monthCents: number;
  creditUsd: number;
  /** When the snapshot was taken (D1 time, UTC); ages are shown relative to it. */
  asOf?: string;
  /** Spec changes building, in review or live and not yet measured. */
  changes?: { id: string; agent: string; state: string; pr_url: string | null }[];
}

/** Live sessions /status re-reads from Managed Agents first, at most, so it doesn't wait on webhooks. */
export const REFRESH_LIMIT = 10;

/**
 * Processes the live sessions as a webhook would, so tasks, statuses and spend are
 * current before /status reads them. Never throws: a failure leaves the old figures.
 */
export async function refreshLive(ctx: Ctx, limit = REFRESH_LIMIT) {
  const rows = await ctx.db.liveSessions(limit).catch(() => []);
  await Promise.all(
    rows.map((r) =>
      processSession(ctx, r.id).catch((err) =>
        ctx.db.audit({ agent: r.agent, session_id: r.id, event_type: "gateway.status_refresh_error", detail: String(err) }).catch(() => undefined),
      ),
    ),
  );
}

const d1Time = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);

/** How long before `now` a D1 timestamp was: "just now", "12m ago", "5h ago", "3d ago". */
export function ago(at: string, now: string): string {
  const mins = Math.floor((Date.parse(`${now.replace(" ", "T")}Z`) - Date.parse(`${at.replace(" ", "T")}Z`)) / 60_000);
  if (!(mins >= 1)) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 48 * 60) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / 1440)}d ago`;
}

export async function gatherStatus(ctx: Ctx): Promise<NetworkStatus> {
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().replace("T", " ").slice(0, 19);
  const monthStart = new Date().toISOString().slice(0, 8) + "01 00:00:00";
  const [controls, statuses, tasks, open, spendWeek, spendMonth, changes, live] = await Promise.all([
    ctx.db.allAgentStatuses(),
    ctx.db.latestStatuses(),
    ctx.db.openTasks(),
    ctx.db.listDecisions({ status: "open" }),
    ctx.db.spendByAgent(weekAgo),
    ctx.db.spendByAgent(monthStart),
    ctx.db.changesIn(["building", "pr_open", "live"]),
    ctx.db.liveSessions(),
  ]);
  const agents = Object.values(ctx.network.agents)
    .filter((a) => a.phase <= ctx.network.current_phase)
    .sort((x, y) => x.phase - y.phase)
    .map((a) => {
      const st = statuses.find((s) => s.agent === a.name);
      const mine = live.filter((r) => r.agent === a.name).map((r) => r.created_at).sort();
      return {
        name: a.name,
        title: a.title,
        state: ctx.deployed.agents[a.name] ? controls[a.name] ?? "active" : "not deployed",
        tasks: tasks.filter((t) => t.agent === a.name).length,
        blockedTasks: tasks.filter((t) => t.agent === a.name && t.status === "blocked").length,
        decisions: open.filter((d) => d.agent === a.name).length,
        weekCents: spendWeek[a.name] ?? 0,
        ...(mine.length ? { live: { count: mine.length, since: mine[0] } } : {}),
        last: st ? { at: st.at, line: st.doing[0] ?? st.done[0] ?? "—", doing: st.doing, blocked: st.blocked } : undefined,
      };
    });
  return {
    phase: ctx.network.current_phase,
    dryRun: ctx.dryRun,
    agents,
    monthCents: Object.values(spendMonth).reduce((x, y) => x + y, 0),
    creditUsd: ctx.network.monthly_credit_usd,
    asOf: d1Time(new Date()),
    changes: changes.map((c) => ({ id: c.id, agent: c.agent, state: c.state, pr_url: c.pr_url })),
  };
}

const usd = (c = 0) => `$${(c / 100).toFixed(2)}`;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** " (3d ago)" when the snapshot has a time, else nothing. */
const age = (s: NetworkStatus, at: string) => (s.asOf ? ` (${ago(at, s.asOf)})` : "");

/** "1 session, started 12m ago" or "2 sessions, the oldest started 3h ago". */
function liveLine(s: NetworkStatus, live: NonNullable<AgentStatusRow["live"]>): string {
  const started = s.asOf ? `, ${live.count === 1 ? "" : "the oldest "}started ${ago(live.since, s.asOf)}` : "";
  return `${plural(live.count, "session")}${started}`;
}

/** An open change's agent, state and PR link if it has one. */
const changeLine = (c: NonNullable<NetworkStatus["changes"]>[number]) => [cap(c.agent), c.state, ...(c.pr_url ? [c.pr_url] : [])].join(" · ");

/** Telegram: plain text, unchanged from the original /status. */
export function statusPlain(s: NetworkStatus): string {
  const out = [`Phase ${s.phase}${s.dryRun ? " · DRY RUN" : ""}`];
  for (const a of s.agents) {
    out.push(
      `${cap(a.name)} (${a.title}) · ${a.state} · tasks ${a.tasks}${a.blockedTasks ? ` (${a.blockedTasks} blocked)` : ""} · decisions ${a.decisions} · 7d ${usd(a.weekCents)}` +
        (a.live ? `\n  working now: ${liveLine(s, a.live)}` : "") +
        (a.last ? `\n  last report ${a.last.at}${age(s, a.last.at)}: ${a.last.line}` : ""),
    );
  }
  if (s.changes?.length) out.push(["Changes in flight:", ...s.changes.map((c) => `  ${c.id} ${changeLine(c)}`)].join("\n"));
  out.push(`Month to date ${usd(s.monthCents)} of $${s.creditUsd} credits`);
  return out.join("\n");
}

const STATE_MARK: Record<string, string> = {
  active: "🟢",
  paused: "⏸️",
  stopped: "⛔",
  revoked: "🚫",
  "not deployed": "⚪",
};

/** Keeps agent-written text from breaking the layout or pinging anyone. */
export function discordSafe(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").replace(/@/g, "@​").replace(/([*_`~|>#\\])/g, "\\$1").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}


const STATE_COLOUR: Record<string, number> = {
  active: 0x2e9e5b,
  paused: 0xe0a100,
  stopped: 0xd03b3b,
  revoked: 0xd03b3b,
  "not deployed": 0x8a8f98,
};

/** Discord: a header, then one card per agent with its whole latest report. */
export function statusCards(s: NetworkStatus): DiscordPayload {
  const pct = s.creditUsd ? Math.round((s.monthCents / 100 / s.creditUsd) * 100) : 0;
  const changes = s.changes ?? [];
  const content = [
    `### Agent network · Phase ${s.phase}`,
    `-# ${s.dryRun ? "DRY RUN: approved actions are logged, not executed" : "Live: approved actions execute"} · ${usd(s.monthCents)} of $${s.creditUsd} credits this month (${pct}%)${changes.length ? ` · ${plural(changes.length, "change")} in flight` : ""}`,
    // Discord allows 2,000 characters in a message's text.
    ...changes.slice(0, 10).map((c) => `- ${c.id} · ${changeLine(c)}`),
    ...(changes.length > 10 ? [`-# ${changes.length - 10} more not shown.`] : []),
  ].join("\n");
  // Discord allows 6,000 characters across a message's cards and 4,096 in one.
  const budget = Math.floor(6000 / Math.max(s.agents.length, 1));
  const embeds = s.agents.map((a) => {
    const title = `${STATE_MARK[a.state] ?? "⚪"} ${cap(a.name)} · ${a.title}${a.state === "active" ? "" : ` · ${a.state}`}`;
    const lines = [`${plural(a.tasks, "open task")}${a.blockedTasks ? ` (${a.blockedTasks} blocked)` : ""} · ${plural(a.decisions, "decision")} waiting · ${usd(a.weekCents)} this week`];
    if (a.live) lines.push(`**Working now** · ${liveLine(s, a.live)}`);
    lines.push("");
    if (!a.last) lines.push("No report yet.");
    else {
      lines.push(`**Last report** ${a.last.at.slice(5, 16)}${s.asOf ? ` · ${ago(a.last.at, s.asOf)}` : ""}`);
      for (const item of a.last.doing.length ? a.last.doing : [a.last.line]) lines.push(`- ${discordSafe(item, 4096)}`);
      if (a.last.blocked.length) lines.push("", "**Blocked**", ...a.last.blocked.map((b) => `- ${discordSafe(b, 4096)}`));
    }
    const max = Math.min(4096, budget - title.length);
    const text = lines.join("\n");
    const description = text.length > max ? `${text.slice(0, max - 1)}…` : text;
    return { title, description, color: STATE_COLOUR[a.state] ?? STATE_COLOUR["not deployed"] };
  });
  return { content, embeds };
}

const RISK_MARK: Record<string, string> = { low: "🟢", medium: "🟡", high: "🔴" };

/** Discord /queue: one line per decision, newest work last. */
export function queueMarkdown(open: Decision[], footer?: string): string {
  if (!open.length) return "### Decision queue\nNothing waiting.";
  const out = [`### Decision queue · ${open.length} waiting`, ""];
  for (const d of open.slice(0, 20)) {
    out.push(`${RISK_MARK[d.risk] ?? "⚪"} **${d.id}** · ${cap(d.agent)} · \`${d.kind}\``);
    out.push(`-# ${discordSafe(d.summary, 160)}`);
  }
  if (open.length > 20) out.push("", `-# ${open.length - 20} more not shown.`);
  if (footer) out.push("", footer);
  return out.join("\n");
}
