import { describe, expect, it } from "vitest";
import { PR_HISTORY, communityStats, historyRow, syncPrHistory } from "../src/community";
import type { PrHistoryRow } from "../src/db";
import type { PrHistoryNode } from "../src/github";
import { handleTool } from "../src/tools";
import { fakeGitHub, makeTestCtx } from "./helpers";

const REPO = "accordproject/concerto";

const node = (number: number, o: Partial<PrHistoryNode> = {}): PrHistoryNode => ({
  number,
  state: "MERGED",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
  closedAt: "2026-10-02T00:00:00Z",
  mergedAt: "2026-10-02T00:00:00Z",
  author: { login: "alice", __typename: "User" },
  reviews: { nodes: [] },
  comments: { nodes: [] },
  ...o,
});

const row = (number: number, author: string | null, created: string, o: Partial<PrHistoryRow> = {}): PrHistoryRow => ({
  repo: REPO,
  number,
  state: "MERGED",
  created_at: created,
  updated_at: created,
  closed_at: null,
  merged_at: null,
  author,
  bot: 0,
  first_response_at: null,
  ...o,
});

describe("PR history rows (decision 76)", () => {
  it("takes the first response from humans other than the author", () => {
    const r = historyRow(
      REPO,
      node(7, {
        createdAt: "2026-10-01T00:00:00Z",
        reviews: { nodes: [{ createdAt: "2026-10-03T00:00:00Z", author: { login: "samlee", __typename: "User" } }] },
        comments: {
          nodes: [
            { createdAt: "2026-10-01T01:00:00Z", author: { login: "alice", __typename: "User" } },
            { createdAt: "2026-10-01T02:00:00Z", author: { login: "codecov", __typename: "Bot" } },
            { createdAt: "2026-10-01T03:00:00Z", author: { login: "github-actions[bot]" } },
            { createdAt: "2026-10-02T00:00:00Z", author: { login: "jo", __typename: "User" } },
            { createdAt: "2026-10-01T04:00:00Z", author: null },
          ],
        },
      }),
    );
    expect(r).toMatchObject({ repo: REPO, number: 7, author: "alice", bot: 0, first_response_at: "2026-10-02T00:00:00Z" });
  });

  it("marks bot authors, including those GraphQL names without [bot]", () => {
    expect(historyRow(REPO, node(1, { author: { login: "dependabot", __typename: "Bot" } })).bot).toBe(1);
    expect(historyRow(REPO, node(2, { author: { login: "dependabot" } })).bot).toBe(1);
    expect(historyRow(REPO, node(3, { author: null })).bot).toBe(1);
  });
});

describe("community metrics (decision 76)", () => {
  const rows = [
    row(1, "alice", "2025-01-10T00:00:00Z", { closed_at: "2025-01-12T00:00:00Z" }),
    row(2, "bob", "2025-06-01T00:00:00Z", { state: "OPEN" }),
    row(3, "alice", "2026-03-01T00:00:00Z", { closed_at: "2026-03-05T00:00:00Z", first_response_at: "2026-03-02T00:00:00Z" }),
    row(4, "carol", "2026-10-01T00:00:00Z", { state: "OPEN", first_response_at: "2026-10-02T00:00:00Z" }),
    row(5, "dependabot", "2026-05-01T00:00:00Z", { bot: 1, closed_at: "2026-05-02T00:00:00Z", first_response_at: "2026-05-01T12:00:00Z" }),
    row(6, "dave", "2026-11-10T00:00:00Z", { state: "CLOSED", closed_at: "2026-11-11T00:00:00Z", first_response_at: "2026-11-12T00:00:00Z" }),
  ];
  const stats = communityStats(rows, new Date("2026-11-13T00:00:00Z"), new Date("2026-11-06T00:00:00Z")) as Record<string, any>;

  it("counts people, newcomers and retention over human authors", () => {
    expect(stats.current).toMatchObject({
      start: "2025-11-13T00:00:00Z",
      end: "2026-11-13T00:00:00Z",
      community_size: 3,
      new_contributors: 2,
      returning_contributors: 1,
      retention_ratio: 0.5,
    });
    expect(stats.prior).toMatchObject({ start: "2024-11-13T00:00:00Z", community_size: 2 });
    expect(stats.prior.new_contributors).toBeUndefined();
  });

  it("measures first response as ap-stats does: closed PRs from every author, with median and P90", () => {
    // Alice 1 day, Dependabot 0.5, Dave 2; Carol's PR is still open.
    expect(stats.current.time_to_first_response_days).toEqual({ n: 3, mean: 1.17, median: 1, p90: 1.8 });
    expect(stats.prior.time_to_first_response_days).toEqual({ n: 0, mean: null, median: null, p90: null });
  });

  it("takes the closure ratio over human-authored PRs", () => {
    expect(stats.current).toMatchObject({ prs_opened: 3, prs_closed: 2, pr_closure_ratio: 0.667 });
    expect(stats.prior).toMatchObject({ prs_opened: 2, prs_closed: 1, pr_closure_ratio: 0.5 });
  });

  it("counts older PRs closed in the window, but not their authors", () => {
    const old = row(9, "erin", "2024-06-01T00:00:00Z", { closed_at: "2026-04-01T00:00:00Z" });
    const s = communityStats([...rows, old], new Date("2026-11-13T00:00:00Z")) as Record<string, any>;
    expect(s.current).toMatchObject({ prs_closed: 3, community_size: 3, new_contributors: 2 });
  });

  it("names the period's newcomers", () => {
    expect(stats.period).toMatchObject({ start: "2026-11-06T00:00:00Z", new_contributors: 1, prs_opened: 1, prs_closed: 1 });
    expect(stats.period.newcomers).toEqual([{ login: "dave", first_pr: `${REPO}#6`, opened: "2026-11-10T00:00:00Z" }]);
  });
});

describe("refreshing the PR history (decision 76)", () => {
  // 05:00 in London in November; the refresh starts at 04:00.
  const now = new Date("2026-11-13T05:00:00Z");
  const pages = (count: number, from = Date.parse("2026-11-12T00:00:00Z")) =>
    Array.from({ length: count }, (_, i) => [node(100 - i, { updatedAt: new Date(from - i * 86_400_000).toISOString(), createdAt: "2026-01-01T00:00:00Z" })]);
  const setup = () => {
    const gh = fakeGitHub();
    const t = makeTestCtx({ github: async () => gh as never });
    return { gh, ...t };
  };
  const audits = async (ctx: ReturnType<typeof setup>["ctx"], type: string) =>
    (await (ctx.db as any).db.prepare("SELECT detail FROM audit WHERE event_type = ?").bind(type).all()).results.map((r: { detail: string }) => JSON.parse(r.detail));

  it("waits until 04:00", async () => {
    const { gh, ctx } = setup();
    gh.history[REPO] = pages(1);
    await syncPrHistory(ctx, new Date("2026-11-13T03:55:00Z"));
    expect(gh.historyCalls).toEqual([]);
  });

  it("spreads the first read over several runs, then reads once a day", async () => {
    const { gh, ctx } = setup();
    gh.history[REPO] = pages(PR_HISTORY.pagesPerRun + 2);
    await syncPrHistory(ctx, now);
    expect(gh.historyCalls).toHaveLength(PR_HISTORY.pagesPerRun);
    expect(await ctx.db.prSync(REPO)).toMatchObject({ synced_from: null, cursor: String(PR_HISTORY.pagesPerRun) });

    await syncPrHistory(ctx, new Date(now.getTime() + 5 * 60_000));
    expect(gh.historyCalls).toHaveLength(PR_HISTORY.pagesPerRun + 2);
    expect(await ctx.db.prSync(REPO)).toEqual({ repo: REPO, synced_from: "2026-11-13T04:50:00Z", run_started: null, cursor: null });
    expect(await ctx.db.prHistorySince("2020-01-01")).toHaveLength(PR_HISTORY.pagesPerRun + 2);

    // Done for the day.
    await syncPrHistory(ctx, new Date(now.getTime() + 10 * 60_000));
    expect(gh.historyCalls).toHaveLength(PR_HISTORY.pagesPerRun + 2);

    // Tomorrow's pass stops at the first page older than today's start.
    gh.historyCalls.length = 0;
    gh.history[REPO] = pages(5, Date.parse("2026-11-14T03:00:00Z"));
    await syncPrHistory(ctx, new Date(now.getTime() + 86_400_000));
    expect(gh.historyCalls).toHaveLength(2);
    expect((await audits(ctx, "gateway.pr_sync")).at(-1)).toMatchObject({ date: "2026-11-14", finished: [REPO] });
  });

  it("keeps 24 months before the oldest as_of, from midnight, and older PRs closed since", async () => {
    const { gh, ctx } = setup();
    // The oldest as_of is 31 days back (13 October), so the history starts at midnight on 13 October 2024.
    gh.history[REPO] = [
      [
        node(1, { createdAt: "2026-06-01T00:00:00Z" }),
        node(2, { createdAt: "2024-10-12T23:00:00Z", closedAt: "2024-10-12T23:30:00Z" }),
        node(3, { createdAt: "2024-10-13T00:00:00Z", closedAt: "2024-10-14T00:00:00Z" }),
        node(4, { createdAt: "2024-06-01T00:00:00Z", closedAt: "2026-06-01T00:00:00Z" }),
      ],
    ];
    await ctx.db.putPrHistory([row(5, "old", "2024-01-01T00:00:00Z"), row(6, "old", "2024-01-01T00:00:00Z", { closed_at: "2024-02-01T00:00:00Z" })]);
    await syncPrHistory(ctx, now);
    expect((await ctx.db.prHistorySince("2000-01-01")).map((r) => r.number).sort()).toEqual([1, 3, 4]);
    expect((await ctx.db.prHistorySince("2026-01-01")).map((r) => r.number).sort()).toEqual([1, 4]);
  });

  it("leaves a failing repo until tomorrow and records the error", async () => {
    const { gh, ctx } = setup();
    gh.failHistory = "GitHub GraphQL: Resource not accessible by integration";
    await syncPrHistory(ctx, now);
    await syncPrHistory(ctx, new Date(now.getTime() + 5 * 60_000));
    expect(gh.historyCalls).toHaveLength(1);
    expect(await audits(ctx, "gateway.pr_sync_error")).toEqual([{ repo: REPO, error: gh.failHistory }]);
    expect(await ctx.db.prSync(REPO)).toMatchObject({ run_started: null, cursor: null });
  });

  it("resumes after running out of subrequests, without an error", async () => {
    const { gh, ctx } = setup();
    gh.history[REPO] = pages(2);
    gh.failHistory = "Too many subrequests.";
    await syncPrHistory(ctx, now);
    expect(await audits(ctx, "gateway.pr_sync_error")).toEqual([]);
    gh.failHistory = null;
    await syncPrHistory(ctx, new Date(now.getTime() + 5 * 60_000));
    expect((await ctx.db.prSync(REPO))?.synced_from).toBe("2026-11-13T04:50:00Z");
  });
});

describe("community_stats (decision 76)", () => {
  const today = new Date().toISOString().slice(0, 10);

  it("gives Vera the figures and says when the history is incomplete", async () => {
    const { ctx } = makeTestCtx();
    await ctx.db.putPrHistory([row(1, "alice", new Date(Date.now() - 30 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z"))]);
    let r = JSON.parse(await handleTool(ctx, "vera", "sv", "community_stats", {}));
    expect(r.current.community_size).toBe(1);
    expect(r.data).toMatchObject({ complete: false, synced: { [REPO]: null }, prs: 1 });
    expect(r.data.warning).toMatch(/provisional/);

    await ctx.db.setPrSync({ repo: REPO, synced_from: "2026-11-13T04:50:00Z", run_started: null, cursor: null });
    r = JSON.parse(await handleTool(ctx, "vera", "sv", "community_stats", { as_of: today }));
    expect(r.data).toEqual({ complete: true, synced: { [REPO]: "2026-11-13T04:50:00Z" }, prs: 1 });
  });

  it("counts only the repos in scope", async () => {
    const { ctx } = makeTestCtx();
    const recent = new Date(Date.now() - 30 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    await ctx.db.putPrHistory([row(1, "alice", recent), { ...row(2, "zed", recent), repo: "accordproject/removed" }]);
    const r = JSON.parse(await handleTool(ctx, "vera", "sv", "community_stats", {}));
    expect(r.current.community_size).toBe(1);
    expect(r.data.prs).toBe(1);
  });

  it("refuses dates the history can't answer", async () => {
    const { ctx } = makeTestCtx();
    await expect(handleTool(ctx, "vera", "sv", "community_stats", { as_of: today, since: "2020-01-01" })).rejects.toThrow(/24 months before as_of/);
    await expect(handleTool(ctx, "vera", "sv", "community_stats", { as_of: "2025-01-01" })).rejects.toThrow(/last 31 days/);
    await expect(handleTool(ctx, "vera", "sv", "community_stats", { as_of: "13/11/2026" })).rejects.toThrow(/ISO date/);
    await expect(handleTool(ctx, "vera", "sv", "community_stats", { as_of: today, since: today })).rejects.toThrow(/before as_of/);
  });

  it("is Vera's alone", async () => {
    const { ctx } = makeTestCtx();
    await expect(handleTool(ctx, "mira", "sm", "community_stats", {})).rejects.toThrow(/not available to mira/);
  });
});
