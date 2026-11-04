import assert from "node:assert/strict";
import { test } from "node:test";
import { changeIds, deployedChanges, mergedPrs, recordSql } from "./record-deploy";

test("changeIds finds none, one, and unique ids", () => {
  assert.deepEqual(changeIds("feat: x\n\nbody"), []);
  assert.deepEqual(changeIds("feat: x\n\nChange: C-7\n"), ["C-7"]);
  assert.deepEqual(changeIds("a\nChange: C-2\n\nb\nChange: C-2\nChange: C-10"), ["C-2", "C-10"]);
});

test("changeIds ignores a Change: line that is not on its own", () => {
  assert.deepEqual(changeIds("see Change: C-3 for more"), []);
  assert.deepEqual(changeIds("Change: C-3 and more"), []);
});

test("recordSql marks only open or stale-closed changes live and records the deploy", () => {
  const sha = "a".repeat(40);
  const sql = recordSql(sha, ["C-1", "C-22"]);
  assert.ok(sql.includes("WHERE id IN ('C-1', 'C-22')"));
  assert.ok(sql.includes("state = 'pr_open' OR (state = 'closed' AND closed_reason = 'stale')"));
  assert.ok(sql.includes("SET state = 'live', live_at = datetime('now'), closed_reason = NULL, updated_at = datetime('now')"));
  assert.ok(sql.includes(`INSERT OR IGNORE INTO deploys (commit_sha) VALUES ('${sha}')`));
});

test("recordSql with no ids only records the deploy", () => {
  const sql = recordSql("b".repeat(40), []);
  assert.ok(!sql.includes("UPDATE"));
  assert.ok(sql.includes("INSERT OR IGNORE INTO deploys"));
});

test("recordSql refuses a bad id or commit", () => {
  assert.throws(() => recordSql("a".repeat(40), ["C-1'; DROP TABLE changes;--"]));
  assert.throws(() => recordSql("a".repeat(40), ["X-1"]));
  assert.throws(() => recordSql("not-a-sha", ["C-1"]));
  assert.throws(() => recordSql("a'b", []));
});

const REPO = "accordproject/virtual-agent-org";
const pr = (n: number, repo = REPO) => `https://github.com/${repo}/pull/${n}`;

test("mergedPrs reads squash and merge-commit subjects, not PR numbers in a body", () => {
  const log = ["docs(mira): a fix (#22)\n\nSigned-off-by: x", "Merge pull request #30 from a/b\n\nfeat: y", "feat: z\n\nsee (#40)", ""].join("\0");
  assert.deepEqual([...mergedPrs(log)].sort(), [22, 30]);
});

test("deployedChanges finds a change by its PR when the squash dropped its Change: line", () => {
  // As PR #22 merged: the squash kept the title and sign-off, not "Change: C-1".
  const log = "docs(mira): check for an already-merged fix before a first response (#22)\n\nSigned-off-by: bot\n\0";
  assert.deepEqual(deployedChanges(log, [{ id: "C-1", pr_url: pr(22) }, { id: "C-2", pr_url: pr(23) }], REPO), ["C-1"]);
});

test("deployedChanges still accepts the Change: line, and ignores another repo's PR", () => {
  const log = "feat: a\n\nChange: C-3\n\0fix: b (#9)\n\0";
  assert.deepEqual(deployedChanges(log, [{ id: "C-3", pr_url: null }, { id: "C-4", pr_url: pr(9, "someone/else") }], REPO), ["C-3"]);
});
