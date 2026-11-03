// Network status, gathered once and rendered for each app:
// plain text for Telegram, Discord cards for Discord.

import { cap, type Ctx } from "./context";
import type { Decision } from "./db";
import type { DiscordPayload } from "./discordBot";

export interface AgentStatusRow {
  name: string;
  title: string;
  state: string; // active | paused | stopped | revoked | not deployed
  tasks: number;
  /** How many of those tasks ended blocked and wait on a follow-up. */
  blockedTasks?: number;
  decisions: number;
  weekCents: number;
  last?: { at: string; line: string; doing: string[]; blocked: string[] };
}

export interface NetworkStatus {
  phase: number;
  dryRun: boolean;
  agents: AgentStatusRow[];
  monthCents: number;
  creditUsd: number;
  /** Spec changes building, in review or live and not yet measured. */
  openChanges?: number;
}

export async function gatherStatus(ctx: Ctx): Promise<NetworkStatus> {
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().replace("T", " ").slice(0, 19);
  const monthStart = new Date().toISOString().slice(0, 8) + "01 00:00:00";
  const [controls, statuses, tasks, open, spendWeek, spendMonth, changes] = await Promise.all([
    ctx.db.allAgentStatuses(),
    ctx.db.latestStatuses(),
    ctx.db.openTasks(),
    ctx.db.listDecisions({ status: "open" }),
    ctx.db.spendByAgent(weekAgo),
    ctx.db.spendByAgent(monthStart),
    ctx.db.changesIn(["building", "pr_open", "live"]),
  ]);
  const agents = Object.values(ctx.network.agents)
    .filter((a) => a.phase <= ctx.network.current_phase)
    .sort((x, y) => x.phase - y.phase)
    .map((a) => {
      const st = statuses.find((s) => s.agent === a.name);
      return {
        name: a.name,
        title: a.title,
        state: ctx.deployed.agents[a.name] ? controls[a.name] ?? "active" : "not deployed",
        tasks: tasks.filter((t) => t.agent === a.name).length,
        blockedTasks: tasks.filter((t) => t.agent === a.name && t.status === "blocked").length,
        decisions: open.filter((d) => d.agent === a.name).length,
        weekCents: spendWeek[a.name] ?? 0,
        last: st ? { at: st.at, line: st.doing[0] ?? st.done[0] ?? "—", doing: st.doing, blocked: st.blocked } : undefined,
      };
    });
  return {
    phase: ctx.network.current_phase,
    dryRun: ctx.dryRun,
    agents,
    monthCents: Object.values(spendMonth).reduce((x, y) => x + y, 0),
    creditUsd: ctx.network.monthly_credit_usd,
    openChanges: changes.length,
  };
}

const usd = (c = 0) => `$${(c / 100).toFixed(2)}`;

/** Telegram: plain text, unchanged from the original /status. */
export function statusPlain(s: NetworkStatus): string {
  const out = [`Phase ${s.phase}${s.dryRun ? " · DRY RUN" : ""}`];
  for (const a of s.agents) {
    out.push(
      `${cap(a.name)} (${a.title}) · ${a.state} · tasks ${a.tasks}${a.blockedTasks ? ` (${a.blockedTasks} blocked)` : ""} · decisions ${a.decisions} · 7d ${usd(a.weekCents)}` +
        (a.last ? `\n  last report ${a.last.at}: ${a.last.line}` : ""),
    );
  }
  if (s.openChanges) out.push(`Changes in flight: ${s.openChanges}`);
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

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

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
  const content = [
    `### Agent network · Phase ${s.phase}`,
    `-# ${s.dryRun ? "DRY RUN: approved actions are logged, not executed" : "Live: approved actions execute"} · ${usd(s.monthCents)} of $${s.creditUsd} credits this month (${pct}%)${s.openChanges ? ` · ${plural(s.openChanges, "change")} in flight` : ""}`,
  ].join("\n");
  // Discord allows 6,000 characters across a message's cards and 4,096 in one.
  const budget = Math.floor(6000 / Math.max(s.agents.length, 1));
  const embeds = s.agents.map((a) => {
    const title = `${STATE_MARK[a.state] ?? "⚪"} ${cap(a.name)} · ${a.title}${a.state === "active" ? "" : ` · ${a.state}`}`;
    const lines = [`${plural(a.tasks, "open task")}${a.blockedTasks ? ` (${a.blockedTasks} blocked)` : ""} · ${plural(a.decisions, "decision")} waiting · ${usd(a.weekCents)} this week`, ""];
    if (!a.last) lines.push("No report yet.");
    else {
      lines.push(`**Last report** ${a.last.at.slice(5, 16)}`);
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
