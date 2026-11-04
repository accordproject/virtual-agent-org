// Records which changes a deploy made live. Reads the changes still waiting on their
// PR from D1, marks live those whose PR is merged into the deployed history, and
// stores the new commit. Run by the deploy workflow after a real deploy.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { readYaml } from "./lib";

const D1 = "virtual-agent-org1";

export function changeIds(log: string): string[] {
  const ids = [...log.matchAll(/^Change: (C-\d+)$/gm)].map((m) => m[1]);
  return [...new Set(ids)];
}

/** The PR numbers merged in a log of NUL-separated commit messages: "title (#22)" or "Merge pull request #22 from". */
export function mergedPrs(log: string): Set<number> {
  const out = new Set<number>();
  for (const msg of log.split("\0")) {
    const subject = msg.trim().split("\n")[0] ?? "";
    const m = subject.match(/\(#(\d+)\)$/) ?? subject.match(/^Merge pull request #(\d+) from /);
    if (m) out.add(Number(m[1]));
  }
  return out;
}

/**
 * The pending changes the log shows deployed: by their PR number, since a squash merge
 * can drop the `Change:` line from the commit body, or by that line where it survives.
 * Every pending change is checked against the whole history, so one missed by an
 * earlier deploy is caught by the next.
 */
export function deployedChanges(log: string, pending: { id: string; pr_url: string | null }[], repo: string): string[] {
  const prs = mergedPrs(log);
  const named = new Set(changeIds(log));
  const prefix = `https://github.com/${repo}/pull/`;
  return pending
    .filter((c) => {
      const n = c.pr_url?.startsWith(prefix) ? Number(c.pr_url.slice(prefix.length)) : NaN;
      return named.has(c.id) || prs.has(n);
    })
    .map((c) => c.id);
}

export function recordSql(commit: string, ids: string[]): string {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`Not a commit sha: ${commit}`);
  for (const id of ids) if (!/^C-\d+$/.test(id)) throw new Error(`Not a change id: ${id}`);
  const update = ids.length
    ? `UPDATE changes SET state = 'live', live_at = datetime('now'), closed_reason = NULL, updated_at = datetime('now') WHERE id IN (${ids.map((i) => `'${i}'`).join(", ")}) AND (state = 'pr_open' OR (state = 'closed' AND closed_reason = 'stale')); `
    : "";
  return `${update}INSERT OR IGNORE INTO deploys (commit_sha) VALUES ('${commit}');`;
}

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();

function wrangler(command: string): string {
  return execFileSync("npx", ["wrangler", "d1", "execute", D1, "--remote", "--json", "--command", command], {
    cwd: join(import.meta.dirname, "..", "gateway"),
    encoding: "utf8",
  });
}

/** Changes whose PR is open, or was closed as stale and may have been merged since. */
function pendingChanges(): { id: string; pr_url: string | null }[] {
  const out = JSON.parse(wrangler("SELECT id, pr_url FROM changes WHERE state = 'pr_open' OR (state = 'closed' AND closed_reason = 'stale')"));
  return out?.[0]?.results ?? [];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const head = git("rev-parse", "HEAD");
  const repo = readYaml<{ github: { network_repo: string } }>("config/network.yaml").github.network_repo;
  const ids = deployedChanges(git("log", "--format=%B%x00", "HEAD"), pendingChanges(), repo);
  const sql = recordSql(head, ids);
  if (process.argv.includes("--dry-run")) {
    console.log(sql);
  } else {
    wrangler(sql);
    console.log(`Recorded ${head}${ids.length ? ` with ${ids.join(", ")}` : ""}.`);
  }
}
