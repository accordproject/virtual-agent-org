import assert from "node:assert/strict";
import { test } from "node:test";
import { SAFETY_PATHS, flagged } from "./flag-safety";

test("flagged matches each safety path", () => {
  for (const p of SAFETY_PATHS.filter((p) => !p.endsWith("/"))) assert.deepEqual(flagged([p]), [p]);
});

test("flagged matches anything under .github/", () => {
  assert.deepEqual(flagged([".github/workflows/ci.yml"]), [".github/workflows/ci.yml"]);
});

test("flagged ignores other files and near misses", () => {
  assert.deepEqual(flagged(["README.md", "gateway/src/actions.test.ts", "gateway/src/actionsX.ts", "agents/mira.md", "docs/.github/x", "config/permissions.yaml.bak"]), []);
});

test("flagged keeps only the safety files from a mixed list", () => {
  assert.deepEqual(flagged(["README.md", "gateway/src/risk.ts", "agents/mechanic.md"]), ["gateway/src/risk.ts", "agents/mechanic.md"]);
});
