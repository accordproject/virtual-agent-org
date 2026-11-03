import assert from "node:assert/strict";
import { test } from "node:test";
import { changeIds, recordSql } from "./record-deploy";

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
