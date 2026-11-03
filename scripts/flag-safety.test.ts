import assert from "node:assert/strict";
import { test } from "node:test";
import { SAFETY_PATHS, flagged } from "./flag-safety";

test("flagged matches each safety path", () => {
  for (const p of SAFETY_PATHS.filter((p) => !p.endsWith("/"))) assert.deepEqual(flagged([p]), [p]);
});

test("flagged matches anything under .github/", () => {
  assert.deepEqual(flagged([".github/workflows/ci.yml"]), [".github/workflows/ci.yml"]);
});

test("flagged matches anything under scripts/ and the files that run or steer the gateway", () => {
  const paths = ["scripts/lib.ts", "scripts/flag-safety.ts", "gateway/src/tools.ts", "gateway/src/people.ts", "gateway/src/index.ts", "agents/_protocol.md", "config/network.yaml", "package.json", "package-lock.json", "gateway/package.json", "gateway/package-lock.json"];
  assert.deepEqual(flagged(paths), paths);
});

test("flagged ignores other files and near misses", () => {
  assert.deepEqual(flagged(["README.md", "gateway/src/actions.test.ts", "gateway/src/actionsX.ts", "agents/mira.md", "docs/.github/x", "config/permissions.yaml.bak"]), []);
});

test("flagged keeps only the safety files from a mixed list", () => {
  assert.deepEqual(flagged(["README.md", "gateway/src/risk.ts", "agents/mandla.md"]), ["gateway/src/risk.ts", "agents/mandla.md"]);
});
