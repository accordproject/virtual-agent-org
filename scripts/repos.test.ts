import assert from "node:assert/strict";
import { test } from "node:test";
import { REPOS_MARKER, addRepoToNetworkYaml, renderContext, workflowRisks } from "./repos";

const NETWORK = `github:
  org: accordproject
  # Add real repos in Phase 1.
  sandbox_repo: accordproject/sandbox
  repos:
    - accordproject/concerto # in scope
  # trailing comment
`;

test("addRepoToNetworkYaml appends the repo and keeps comments", () => {
  const out = addRepoToNetworkYaml(NETWORK, "accordproject/web-components")!;
  assert.equal(out, NETWORK.replace("# in scope\n", "# in scope\n    - accordproject/web-components\n"));
});

test("addRepoToNetworkYaml returns null when the repo is already listed", () => {
  assert.equal(addRepoToNetworkYaml(NETWORK, "AccordProject/Concerto"), null);
});

test("renderContext lists the repos and the sandbox in place of the marker", () => {
  const out = renderContext(`## Repos in scope\n\n${REPOS_MARKER}\n\n## Next`, ["accordproject/concerto"], "accordproject/sandbox");
  assert.equal(out, "## Repos in scope\n\n- accordproject/concerto\n- accordproject/sandbox (for testing the network itself)\n\n## Next");
});

test("renderContext refuses a context file without the marker", () => {
  assert.throws(() => renderContext("## Repos in scope\n", [], ""), /missing the line/);
});

test("workflowRisks flags pull_request_target and runners that aren't GitHub-hosted", () => {
  const wf = `on:
  pull_request_target:
    types: [opened]
jobs:
  build:
    runs-on: [self-hosted, linux]
  test:
    runs-on: \${{ inputs.runner }}
  gpu:
    runs-on: gpu-box
  lint:
    runs-on: ubuntu-latest
`;
  assert.deepEqual(workflowRisks(wf), [
    "uses pull_request_target",
    "job build runs on self-hosted, linux, not a GitHub-hosted runner",
    "job test picks its runner from an expression; check it by hand",
    "job gpu runs on gpu-box, not a GitHub-hosted runner",
  ]);
});

test("workflowRisks resolves a runner from the job's matrix", () => {
  const wf = (os: string) => `on: pull_request
jobs:
  build:
    strategy:
      matrix:
        os: [${os}]
        include:
          - os: macos-latest
    runs-on: \${{ matrix.os }}
`;
  assert.deepEqual(workflowRisks(wf("windows-latest, ubuntu-latest")), []);
  assert.deepEqual(workflowRisks(wf("ubuntu-latest, my-runner")), ["job build runs on my-runner, not a GitHub-hosted runner"]);
});

test("workflowRisks passes an ordinary pull_request workflow", () => {
  assert.deepEqual(workflowRisks("on: [push, pull_request]\njobs:\n  t:\n    runs-on: ubuntu-latest\n"), []);
});
