// Records which changes a deploy made live. Reads the last deployed commit from D1,
// collects the `Change: C-n` lines in the commits since, marks those changes live
// and stores the new commit. Run by the deploy workflow after a real deploy.
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const D1 = "virtual-agent-org1";

export function changeIds(log: string): string[] {
  const ids = [...log.matchAll(/^Change: (C-\d+)$/gm)].map((m) => m[1]);
  return [...new Set(ids)];
}

export function recordSql(commit: string, ids: string[]): string {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`Not a commit sha: ${commit}`);
  for (const id of ids) if (!/^C-\d+$/.test(id)) throw new Error(`Not a change id: ${id}`);
  const update = ids.length
    ? `UPDATE changes SET state = 'live', live_at = datetime('now'), updated_at = datetime('now') WHERE id IN (${ids.map((i) => `'${i}'`).join(", ")}) AND (state = 'pr_open' OR (state = 'closed' AND closed_reason = 'stale')); `
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

function lastDeployed(): string | undefined {
  const out = JSON.parse(wrangler("SELECT commit_sha FROM deploys ORDER BY ts DESC, rowid DESC LIMIT 1"));
  const sha = out?.[0]?.results?.[0]?.commit_sha;
  return typeof sha === "string" ? sha : undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const head = git("rev-parse", "HEAD");
  const last = lastDeployed();
  let ids: string[] = [];
  if (last) {
    try {
      ids = changeIds(git("log", "--format=%B", `${last}..HEAD`));
    } catch {
      console.log(`Last deployed commit ${last} isn't in this history; recording no changes.`);
    }
  } else {
    console.log("No earlier deploy on record; recording this one without any changes.");
  }
  const sql = recordSql(head, ids);
  if (process.argv.includes("--dry-run")) {
    console.log(sql);
  } else {
    wrangler(sql);
    console.log(`Recorded ${head}${ids.length ? ` with ${ids.join(", ")}` : ""}.`);
  }
}
