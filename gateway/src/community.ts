// Community metrics for Vera (decision 76), copied from the ap-stats method
// (github.com/mttrbrts/ap-stats): read every PR of the last 24 months in bulk, with the
// first 20 reviews and comments of each, then compute the metrics in code from that one
// dataset. Vera copies the figures; she doesn't read PRs one by one.
//
// The cron refreshes the history once a day, a few pages per run so no run uses up its
// subrequests; the first pass (24 months) spreads over several runs. community_stats
// reads only the database.

import { outOfSubrequests, type Ctx } from "./context";
import type { PrHistoryRow, PrSyncRow } from "./db";
import { parseTarget, type Actor, type GitHub, type PrHistoryNode } from "./github";
import { localClock } from "./githubEvents";

export const PR_HISTORY = {
  /** How far back the history goes: the current 12-month window and the prior one. */
  months: 24,
  /** How far back community_stats' as_of may go; the history keeps enough for the oldest one. */
  asOfDays: 31,
  /** GraphQL pages (100 PRs each) one cron run may read, across all repos. */
  pagesPerRun: 10,
  /** Local time after which the day's refresh starts: before Vera's daily scorecard at 06:00. */
  startsAt: 4 * 60,
  /** A pass reads back to this long before the previous pass started, so clock skew loses nothing. */
  overlapMinutes: 10,
};

/** Bot accounts GraphQL names without "[bot]", as ap-stats lists them. */
const BOT_LOGINS = new Set(["pre-commit-ci", "snyk-bot", "jupyterhub-bot", "dependabot", "renovate", "github-actions"]);

export function isBotActor(a: Actor | null): boolean {
  if (!a?.login) return true;
  return a.__typename === "Bot" || a.login.endsWith("[bot]") || BOT_LOGINS.has(a.login);
}

/** ISO time to the second, as GitHub writes it, so stored times compare as strings. */
export const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/** `d` moved by whole calendar months in UTC, the day clamped to the month's length. */
/** Midnight UTC at the start of `d`'s day. */
export const startOfDay = (d: Date) => new Date(`${d.toISOString().slice(0, 10)}T00:00:00Z`);

/**
 * The oldest time the history keeps: 24 months before the oldest as_of community_stats
 * accepts, at midnight, so every supported window is whole.
 */
export function historyStart(now: Date): string {
  return iso(addMonths(new Date(startOfDay(now).getTime() - PR_HISTORY.asOfDays * 86_400_000), -PR_HISTORY.months));
}

/** Whether a PR belongs in the history: created since its start, or closed since then (for closure counts). */
export const inHistory = (n: { createdAt: string; closedAt: string | null }, start: string) =>
  n.createdAt >= start || (!!n.closedAt && n.closedAt >= start);

export function addMonths(d: Date, months: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
}

/** A PR as stored: the first response is the earliest review or comment by a human other than the author. */
export function historyRow(repo: string, n: PrHistoryNode): PrHistoryRow {
  const author = n.author?.login ?? null;
  const responses = [...(n.reviews?.nodes ?? []), ...(n.comments?.nodes ?? [])]
    .filter((e) => e.author?.login && e.author.login !== author && !isBotActor(e.author))
    .map((e) => e.createdAt)
    .sort();
  return {
    repo,
    number: n.number,
    state: n.state,
    created_at: n.createdAt,
    updated_at: n.updatedAt,
    closed_at: n.closedAt,
    merged_at: n.mergedAt,
    author,
    bot: isBotActor(n.author) ? 1 : 0,
    first_response_at: responses[0] ?? null,
  };
}

/**
 * Refreshes the PR history from the five-minute cron. Once a day after PR_HISTORY.startsAt,
 * each repo starts a pass that reads PRs by last update, newest first, until it reaches the
 * previous pass's start (or 24 months back, the first time). A pass resumes where it left
 * off when a run's page allowance runs out. A repo whose read fails is left until tomorrow,
 * so a broken repo can't fill the audit log. Never throws.
 */
export async function syncPrHistory(ctx: Ctx, now = new Date()) {
  if (!ctx.network.schedules_enabled || !ctx.network.repos.length) return;
  try {
    const { date, minutes } = localClock(ctx.network.timezone, now);
    if (minutes < PR_HISTORY.startsAt) return;
    const cutoff = historyStart(now);
    let pages = PR_HISTORY.pagesPerRun;
    let gh: GitHub | null = null;
    const read: Record<string, number> = {};
    const finished: string[] = [];
    let stopped: string | undefined;
    for (const repo of ctx.network.repos) {
      if (pages <= 0) break;
      const ref = parseTarget(repo);
      if (!ref) continue;
      let state: PrSyncRow = (await ctx.db.prSync(repo)) ?? { repo, synced_from: null, run_started: null, cursor: null };
      if (!state.run_started) {
        if (!(await ctx.db.claimEvent(`pr-sync:${date}:${repo}`))) continue;
        state = { ...state, run_started: iso(new Date(now.getTime() - PR_HISTORY.overlapMinutes * 60_000)), cursor: null };
        await ctx.db.setPrSync(state);
      }
      const stopAt = state.synced_from ?? cutoff;
      try {
        gh ??= await ctx.github();
        while (pages > 0) {
          pages--;
          const page = await gh.prHistoryPage(ref, state.cursor);
          await ctx.db.putPrHistory(page.nodes.filter((n) => inHistory(n, cutoff)).map((n) => historyRow(repo, n)));
          read[repo] = (read[repo] ?? 0) + page.nodes.length;
          const oldest = page.nodes.at(-1)?.updatedAt;
          if (!page.pageInfo.hasNextPage || !oldest || oldest < stopAt) {
            state = { repo, synced_from: state.run_started, run_started: null, cursor: null };
            await ctx.db.setPrSync(state);
            finished.push(repo);
            break;
          }
          state = { ...state, cursor: page.pageInfo.endCursor };
          await ctx.db.setPrSync(state);
        }
      } catch (err) {
        if (outOfSubrequests(err)) {
          // Not the repo's fault: the pass resumes at its cursor next run.
          stopped = "out of subrequests";
          break;
        }
        await ctx.db.setPrSync({ ...state, run_started: null, cursor: null });
        await ctx.db.audit({ event_type: "gateway.pr_sync_error", detail: { repo, error: err instanceof Error ? err.message.slice(0, 300) : String(err) } });
      }
    }
    if (await ctx.db.claimEvent(`pr-prune:${date}`)) await ctx.db.prunePrHistory(cutoff);
    if (Object.keys(read).length || stopped) {
      await ctx.db.audit({ event_type: "gateway.pr_sync", detail: { date, read, finished, ...(stopped ? { stopped } : {}) } });
    }
  } catch (err) {
    await ctx.db.audit({ event_type: "gateway.pr_sync_error", detail: String(err) }).catch(() => undefined);
  }
}

// ---- the metrics ----------------------------------------------------------

export interface Dist {
  n: number;
  mean: number | null;
  median: number | null;
  p90: number | null;
}

/** Percentile with linear interpolation between ranks, as numpy computes it, so figures match ap-stats. */
function percentile(sorted: number[], q: number): number {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;

export function dist(values: number[]): Dist {
  if (!values.length) return { n: 0, mean: null, median: null, p90: null };
  const s = [...values].sort((a, b) => a - b);
  return {
    n: s.length,
    mean: round(s.reduce((a, b) => a + b, 0) / s.length, 2),
    median: round(percentile(s, 0.5), 2),
    p90: round(percentile(s, 0.9), 2),
  };
}

const DAY_MS = 86_400_000;
const days = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / DAY_MS;
const inWindow = (t: string | null, start: string, end: string): t is string => !!t && t >= start && t < end;

/** The metrics for one window [start, end). `firstSeen` is each human author's first PR in the whole history. */
function windowStats(rows: PrHistoryRow[], start: string, end: string) {
  const opened = rows.filter((r) => inWindow(r.created_at, start, end));
  const human = opened.filter((r) => !r.bot && r.author);
  const authors = new Set(human.map((r) => r.author!));
  // ap-stats: merged or closed PRs created in the window that had a response; all authors.
  const responses = opened
    .filter((r) => r.state !== "OPEN" && r.first_response_at)
    .map((r) => days(r.created_at, r.first_response_at!));
  const closed = rows.filter((r) => !r.bot && r.author && inWindow(r.closed_at, start, end)).length;
  return {
    start,
    end,
    authors,
    time_to_first_response_days: dist(responses),
    community_size: authors.size,
    prs_opened: human.length,
    prs_closed: closed,
    pr_closure_ratio: human.length ? round(closed / human.length, 3) : null,
  };
}

/**
 * Community metrics from the PR history, for the 12 months to `asOf` and the 12 months
 * before. `since` adds a short period (a day or a week) with its newcomers by name.
 */
export function communityStats(rows: PrHistoryRow[], asOf: Date, since?: Date) {
  const end = iso(asOf);
  const start = iso(addMonths(asOf, -12));
  const priorStart = iso(addMonths(asOf, -24));
  const firstSeen = new Map<string, PrHistoryRow>();
  // Older PRs are kept only for their closures; contributors count from the 24 months.
  for (const r of [...rows].filter((r) => r.created_at >= priorStart).sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    if (!r.bot && r.author && !firstSeen.has(r.author)) firstSeen.set(r.author, r);
  }
  const current = windowStats(rows, start, end);
  const prior = windowStats(rows, priorStart, start);
  const returning = [...prior.authors].filter((a) => current.authors.has(a)).length;
  const newIn = (from: string, to: string) => [...firstSeen.values()].filter((r) => r.created_at >= from && r.created_at < to);
  const strip = ({ authors: _, ...w }: ReturnType<typeof windowStats>) => w;
  const out: Record<string, unknown> = {
    current: {
      ...strip(current),
      new_contributors: newIn(start, end).length,
      retention_ratio: prior.authors.size ? round(returning / prior.authors.size, 3) : null,
      returning_contributors: returning,
    },
    // No new_contributors or retention for the prior window: the history has no year before it to compare with.
    prior: strip(prior),
  };
  if (since) {
    const from = iso(since);
    const p = windowStats(rows, from, end);
    const newcomers = newIn(from, end);
    out.period = {
      ...strip(p),
      new_contributors: newcomers.length,
      newcomers: newcomers.slice(0, 50).map((r) => ({ login: r.author, first_pr: `${r.repo}#${r.number}`, opened: r.created_at })),
    };
  }
  return out;
}
