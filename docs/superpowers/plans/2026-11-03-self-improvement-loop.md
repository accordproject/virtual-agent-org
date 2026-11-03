# Self-improvement loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn evidence into approved, built and measured changes to the network: Ada proposes, the owner approves, the mechanic builds, the gateway opens the PR, and the gateway measures the effect two weeks after it goes live.

**Architecture:** `spec.change` gets a real executor (`task`) that records a change (`C-n`) and starts a mechanic task. The mechanic, which holds no credential, submits changed files with `submit_change`; the gateway's GitHub App opens the PR on the network's own repo, its only action there. The deploy workflow marks changes live in D1; the gateway's cron measures them from its own tables.

**Tech Stack:** TypeScript, Cloudflare Workers + D1, vitest (gateway), node:test (scripts), GitHub Actions, Claude Managed Agents.

**Spec:** `docs/superpowers/specs/2026-11-03-self-improvement-loop-design.md`

## Global Constraints

- Work on branch `feat/self-improvement-loop`, based on `feat/ada-follow-up` (decisions 49 to 51 and follow-ups must be merged first).
- The network's own repo is `accordproject/virtual-agent-org`. It must never be in `github.repos` or `sandbox_repo`, and no action kind may target it. The one write is `submit_change` opening a PR.
- The mechanic holds no credential: no MCP servers, no vault token, `requestable: []`, built-in tools `read, write, edit, glob, bash` only.
- `spec.change` is requestable by Ada alone. It is not `auto`; `AUTO_KINDS` stays `github.approve_ci` and `github.review`.
- Mechanic session budgets: $1 for `wording` and `tier`; $5 for `tool`, `permission`, `integration`, `architecture`. Deep tier for the $5 types, the mechanic's default (standard) otherwise.
- Risk on the card: `permission`, `integration`, `architecture`, or any change targeting the mechanic → high; `tool` → medium; `wording`, `tier` → low.
- Proposals allowed only when `self_improvement.since` is set and reached, and then only for an agent with at least 10 decided decisions or once 14 days have passed since `since`.
- Measuring: windows of 14 days before and 14 days after `live_at`; at least 5 cases each side, otherwise `too_little_data`, retried weekly until 28 days after the after-window ends, then closed.
- Stale PRs: closed after 30 days by the stale workflow; the gateway closes a change still `pr_open` after the same 30 days.
- Several changes per agent may be in flight. A result lists other changes to the same agent that went live within its windows.
- `submit_change` refuses paths under `.github/`, containing `..`, absolute, or `gateway/src/generated/`; at most 50 files and 500,000 characters in all; once per change.
- Every behaviour change gets a test using `makeTestCtx()`; fakes only, no real APIs. Every client wraps fetch as `(input, init) => fetch(input, init)`.
- Custom tools always answer: errors return a message, never an unanswered call.
- Commits: Conventional Commits with `git commit -s`. Run `npm test` before each commit.
- Plain British English in specs, docs and tool descriptions; the repo is public.

## Review Focus

1. A mechanic session that ends without calling `submit_change`: the task must count as blocked, so the follow-up path runs, not silently "done" with the change stuck in `building`. (Task 7)
2. Ada reassigning a blocked mechanic task with `follows_up`: the new task must take over the change, or its `submit_change` is refused. (Task 7)
3. A `spec.change` payload naming a decision id that doesn't exist, or an evidence list of only free text: refused, so every proposal rests on real rows. (Task 5)
4. A change merged while a deploy run waits for approval, then the stale timer passes: the deploy must still mark it live. (Tasks 8 and 9)
5. A `submit_change` file whose path is `.github/workflows/ci.yml`, `../x` or `/etc/x`: refused before any GitHub call. (Task 6)

---

### Task 1: Log refused custom tool calls

Decision 31 left calls the gateway refuses for bad input (a `ToolError`) unlogged. The loop needs them as evidence and for the `tool_refusals` measure.

**Files:**
- Modify: `gateway/src/sessions.ts:110-120` (the `agent.custom_tool_use` catch)
- Modify: `gateway/src/db.ts` (new `refusals` query beside `denials`)
- Modify: `gateway/src/tools.ts` (`readAudit` returns `refusals`)
- Test: `gateway/test/sessions.test.ts`, `gateway/test/tools.test.ts`

**Interfaces:**
- Produces: audit rows with `event_type: "gateway.tool_refused"`, `tool`, `detail` = the error message (first 300 characters). `Db.refusals(since: string, until: string, limit = 200)` returning the same row shape as `denials`. `read_audit` output gains `refusals`.

- [ ] **Step 1: Write the failing tests**
  - `sessions.test.ts` › `"a tool call refused for bad input is audited as gateway.tool_refused"`: send an `agent.custom_tool_use` for `record_evaluation` with no `agent`; assert one audit row with `event_type === "gateway.tool_refused"`, `tool === "record_evaluation"`, detail containing `"agent is required"`; assert the agent still got `"Error: …"` as its result.
  - `tools.test.ts` › `"read_audit lists refusals"`: insert one refused row, call `read_audit`; assert `refusals.length === 1` and `refusals[0].tool`.
- [ ] **Step 2: Run them and see them fail** — `cd gateway && npx vitest run test/sessions.test.ts test/tools.test.ts` → FAIL.
- [ ] **Step 3: Implement.** In the catch, add the `ToolError` (not `ToolDenied`) branch that audits `gateway.tool_refused`. Add `refusals`; add it to `readAudit`'s `Promise.all` and output, and a note line: "refusals: custom tool calls the gateway refused for bad input".
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Commit** — `fix(gateway): log refused custom tool calls for the audit`.

### Task 2: Config for the network repo, the mechanic and the loop

**Files:**
- Modify: `config/network.yaml`, `config/permissions.yaml`, `config/models.yaml`
- Create: `agents/mechanic.md` (frontmatter and a one-paragraph placeholder body; Task 10 writes the spec)
- Modify: `scripts/lib.ts` (`NetworkYaml` types), `scripts/compile.ts`, `scripts/compile.test.ts`
- Modify: `gateway/src/config.ts`, `gateway/test/helpers.ts` (`NETWORK`)
- Regenerate: `gateway/src/generated/network.json` (`npm run compile`)

**Interfaces:**
- Produces in `network.yaml`:
  ```yaml
  github:
    network_repo: accordproject/virtual-agent-org   # the network's own code (decision 51); never in repos
  self_improvement:
    since: null            # ISO date the loop starts; null = off
    stale_days: 30         # matches .github/workflows/stale.yml
    commit_author: { name: "virtual-agent-org-gateway[bot]", email: "<app bot id>+virtual-agent-org-gateway[bot]@users.noreply.github.com" }
  budgets:
    mechanic_small_usd: 1  # wording and tier changes
    mechanic_large_usd: 5  # tool changes and the owner-only types
  agents:
    mechanic: 1
  ```
- `permissions.yaml`: `spec.change: { risk: low, executor: task }` (the gateway raises risk by change type); `agents.mechanic: { mcp_servers: [], builtin_tools: [read, write, edit, glob, bash], requestable: [] }`.
- `models.yaml`: `agents.mechanic: { default: standard }`.
- `NetworkConfig` gains `network_repo: string` and `self_improvement?: { since: string | null; stale_days: number; commit_author: { name: string; email: string }; task_cents: { small: number; large: number } }`. `ActionKind["executor"]` gains `"task"`.
- `compile()` emits both; `task_cents` from the two budgets × 100.

- [ ] **Step 1: Write the failing tests** in `scripts/compile.test.ts`:
  - `"validate keeps the network repo out of repos and the sandbox"`: put `network_repo` into `github.repos` → error `github.repos: accordproject/virtual-agent-org is the network's own repo (decision 51)`; same for `sandbox_repo`.
  - `"validate lets only ada request spec.change"`: add `spec.change` to mira's `requestable` → error `mira: only ada may request spec.change`.
  - `"validate keeps the mechanic without credentials"`: give mechanic an MCP server → error `mechanic must have no MCP servers, no requestable kinds, and only read, write, edit, glob and bash`.
  - `"validate checks self_improvement"`: `since: "soon"` → `self_improvement.since must be an ISO date or null`; `stale_days: 0` → `self_improvement.stale_days must be a whole number from 1 to 365`; mechanic budgets outside 0 < x ≤ 10 → error.
  - `"compile emits the loop settings"`: `task_cents` equals `{ small: 100, large: 500 }`, `network_repo` set.
  - The existing `assert.deepEqual(validate(cfg), [])` still passes.
- [ ] **Step 2: Run** `npx tsx --test scripts/compile.test.ts` → FAIL.
- [ ] **Step 3: Implement** the config, types and checks above. Add `"task"` to the allowed executors in `validate`.
- [ ] **Step 4: Run** `npm run compile && npm test` → PASS; `network.json` regenerated.
- [ ] **Step 5: Commit** — `feat(config): add the mechanic, the network repo and self-improvement settings`.

### Task 3: The gateway never acts on the network repo

**Files:**
- Modify: `gateway/src/actions.ts` (`inScope`)
- Test: `gateway/test/actions.test.ts`

**Interfaces:**
- Produces: `isNetworkRepo(ctx: Ctx, r: RepoRef): boolean` exported from `actions.ts` (case-insensitive match on `ctx.network.network_repo`). `inScope` returns false when it is true, even if the repo is listed in `repos`.

- [ ] **Step 1: Write the failing test** `"no action kind targets the network's own repo, even if it is listed"`: with `network: { ...NETWORK, repos: [...NETWORK.repos, "accordproject/virtual-agent-org"], network_repo: "accordproject/virtual-agent-org" }`, `validateAction` for `github.comment`, `github.merge`, `github.close` and `github.docs_pr` targeting `accordproject/virtual-agent-org#1` (or the bare repo for `docs_pr`) each throws `ActionInvalid` containing `is not in the configured repos`. Also `label_pr` and `pr_queue` through `handleTool` refuse it.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `isNetworkRepo` and the `inScope` guard.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(gateway): refuse every action on the network's own repo`.

### Task 4: Changes and deploys in D1

**Files:**
- Create: `gateway/migrations/0008_changes.sql`
- Modify: `gateway/src/db.ts`
- Test: `gateway/test/changes.test.ts` (new area; add it to the CLAUDE.md test list in Task 10)

**Interfaces:**
- Migration:
  ```sql
  CREATE TABLE changes (
    id TEXT PRIMARY KEY, seq INTEGER NOT NULL,           -- C-n
    agent TEXT NOT NULL,                                 -- the agent changed, or 'network'
    decision_id TEXT NOT NULL, change_type TEXT NOT NULL, measure TEXT NOT NULL,
    tool TEXT, kinds TEXT NOT NULL DEFAULT '[]',         -- decision kinds named in the evidence (JSON)
    state TEXT NOT NULL DEFAULT 'building',              -- building | pr_open | live | measured | closed
    task_id TEXT, pr_url TEXT, pr_opened_at TEXT, live_at TEXT, measured_at TEXT,
    before REAL, after REAL, before_cases INTEGER, after_cases INTEGER,
    verdict TEXT,                                        -- better | same | worse | too_little_data
    overlaps TEXT, closed_reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX changes_state ON changes(state);
  CREATE INDEX changes_task ON changes(task_id);
  CREATE TABLE deploys (commit_sha TEXT PRIMARY KEY, ts TEXT NOT NULL DEFAULT (datetime('now')));
  ```
  `tasks.kind` gains the value `change` (no constraint to change; update the column comment in the migration).
- `Change` interface mirroring the table. `Db` methods:
  - `createChange(c: { agent; decision_id; change_type; measure; tool?: string; kinds: string[] }): Promise<Change>` (uses `this.next("change")`)
  - `getChange(id: string): Promise<Change | null>`
  - `changeForTask(taskId: string): Promise<Change | null>`
  - `updateChange(id: string, fields: Partial<Omit<Change, "id" | "seq">>): Promise<void>` (sets `updated_at`)
  - `changesIn(states: Change["state"][]): Promise<Change[]>`
  - `createTask` accepts `kind: "change"`.

- [ ] **Step 1: Write the failing test** `"changes are created as C-n and found by task"`: create two changes → ids `C-1`, `C-2`; `updateChange("C-1", { task_id: "T-5", state: "pr_open" })`; `changeForTask("T-5")` returns C-1; `changesIn(["pr_open"])` returns only C-1.
- [ ] **Step 2: Run** `cd gateway && npx vitest run test/changes.test.ts` → FAIL.
- [ ] **Step 3: Implement** the migration and methods.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(gateway): record changes and deploys`.

### Task 5: `spec.change` proposals and their executor

**Files:**
- Create: `gateway/src/changes.ts`
- Modify: `gateway/src/actions.ts` (new `specChange` spec, `ActionSpec.risk?`), `gateway/src/tools.ts` (`requestAction` uses spec risk and the proposal guard)
- Test: `gateway/test/changes.test.ts`, `gateway/test/decisions.test.ts`

**Interfaces:**
- Consumes: Task 4's `Db` methods; `startSession(ctx, agent, text, "task", startedBy, { taskId, budgetCents, model? })`.
- Produces:
  - `CHANGE_TYPES = ["wording", "tier", "tool", "permission", "integration", "architecture"]`, `OWNER_TYPES = ["permission", "integration", "architecture"]`, `MEASURES = ["approval_rate", "repeat_rejections", "tool_refusals", "cost_per_approval"]` in `changes.ts`.
  - Payload `{ change_type, problem (≤2,000), change (≤20,000), evidence: string[] (1–30, each matching /^(D-\d+|T-\d+|audit:\d+|status:\d+)$/), measure, tool? }`. `tool` is required exactly when `measure` is `tool_refusals` and must satisfy `isToolName`. Target: an agent in `ctx.network.agents`, or `network`.
  - `ActionSpec.risk?(n: Normalised): Risk`; `requestAction` uses `maxRisk(declared, floor, spec.risk?.(n) ?? "low")` via an exported `actionRisk(ctx, kind, n)`.
  - `proposalGuard(ctx: Ctx, target: string): Promise<string | null>` — null when allowed, else the refusal text.
  - `startChange(ctx: Ctx, d: Decision, n: Normalised): Promise<ExecResult>` — the `task` executor's body.

- [ ] **Step 1: Write the failing tests** (`changes.test.ts` unless noted):
  - `"spec.change refuses an unknown type, measure or evidence id"`: `change_type: "rewrite"`, `measure: "vibes"`, `evidence: ["see chat"]` → one `ActionInvalid` listing all three.
  - `"spec.change refuses evidence decisions that don't exist"`: `evidence: ["D-999"]` → refusal `evidence D-999 is not a decision`.
  - `"tool_refusals needs a known tool"`: missing `tool` → `payload.tool is required for tool_refusals`; `tool: "nope"` → `nope is not a gateway tool`.
  - `"risk follows the change type"`: wording → low, tool → medium, permission → high, wording targeting `mechanic` → high (card risk stored on the decision).
  - `"proposals wait for the loop to start and for evidence"`: `since: null` → refused `The self-improvement loop is off`; `since` today and the agent with 3 decided decisions → refused naming both thresholds; with 10 decided decisions → queued.
  - `"approving spec.change starts a mechanic task"`: approve through `approve(ctx, id)`; assert one change `C-1` in `building` with `task_id`, a task of kind `change` for `mechanic`, a `createSession` call with budget 100 for wording; for `tool`, budget 500 and `model` equal to `NETWORK.model_tiers.deep`; decision status `executed`, result text names `C-1` and the task id.
  - `decisions.test.ts` › `"the spec.change card shows type, problem, change, evidence and measure"`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `specChange` validates with `Fields` and checks D-/T- ids exist (validation is synchronous today: do the existence check in `requestAction` beside the merge checks, and in `startChange` again, returning `{ ok: false }` if one has gone). `startChange` builds the brief: the approved payload, the change id, and fixed boundaries — "Change only what the decision approved. Don't change files under .github/ or gateway/src/generated/ by hand; run npm run compile if config changed. Never weaken a test. Submit once with submit_change, then report_status." `kinds` = the kinds of the evidence decisions. A `requestAction` from a member's session for `spec.change` is refused (rule 5).
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** — `feat(gateway): spec.change proposals start a mechanic task on approval`.

### Task 6: `submit_change` opens the pull request

**Files:**
- Modify: `gateway/src/toolDefs.ts` (owner `mechanic`), `gateway/src/tools.ts` (handler), `gateway/src/changes.ts` (`submitChange`), `gateway/src/github.ts` (`proposeChange`)
- Modify: `gateway/test/helpers.ts` (`fakeGitHub().proposeChange` recording calls)
- Test: `gateway/test/changes.test.ts`

**Interfaces:**
- Tool input: `{ change: string, title: string (Conventional Commits, ≤100), body: string (≤20,000), files: { path: string, content?: string, delete?: boolean }[] }`.
- `GitHub.proposeChange(r: RepoRef, p: { branch: string; files: { path: string; content: string | null }[]; message: string; author: { name: string; email: string }; title: string; body: string }): Promise<{ html_url: string; number: number }>` — Git data API: read the default branch's head and tree; one `POST git/trees` with `base_tree` and entries `{ path, mode: "100644", type: "blob", content }` (or `sha: null` to delete); `POST git/commits` with `author`; `POST git/refs`; `POST pulls`.
- Commit message: `${title}\n\nChange: ${C-n}\nDecision: ${D-n}\n\nSigned-off-by: ${author.name} <${author.email}>`. Branch `change/c-n`. PR body: a header — change id, decision id, evidence ids, measure, "Built by the mechanic; needs the owner's review like any other PR." — then the mechanic's body under "## Change", with a line `Change: C-n`.

- [ ] **Step 1: Write the failing tests:**
  - `"only the mechanic's change task may submit"`: from Mira's session → `ToolDenied`; from a mechanic session with no change task → `Only a mechanic task started for an approved change can submit`.
  - `"submit_change refuses unsafe paths before calling GitHub"`: `.github/workflows/ci.yml`, `../x`, `/etc/x`, `gateway/src/generated/network.json` → one error listing each; `fakeGitHub` saw no call.
  - `"submit_change refuses more than 50 files or 500,000 characters"`.
  - `"submit_change opens one PR on the network repo"`: `dryRun: false`; assert `proposeChange` called once with `owner/repo` = `accordproject/virtual-agent-org`, branch `change/c-1`, message containing `Change: C-1` and a `Signed-off-by` matching `commit_author`; change state `pr_open`, `pr_url`, `pr_opened_at` set; an audit row `gateway.change_pr_opened`.
  - `"a change is submitted once"`: second call → `C-1 already has a PR: <url>`.
  - `"a GitHub failure leaves the change building"`: `proposeChange` throws → tool error naming the failure; state still `building`, so a fixed call can succeed.
  - `"dry run doesn't open a PR"`: `dryRun: true` → `DRY RUN: would open a PR for C-1`; state `building`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `submitChange(ctx, agent, sessionId, input)` and `proposeChange`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(gateway): the mechanic's changes become PRs through the gateway`.

### Task 7: Mechanic tasks that end without a PR

**Files:**
- Modify: `gateway/src/sessions.ts` (the task-end handler around line 65), `gateway/src/tools.ts` (`assignTask`)
- Test: `gateway/test/changes.test.ts`

**Interfaces:**
- Consumes: `changeForTask`, `updateChange`; decision 50's `wakeAda`.
- Produces: a change task whose session ends with the change still `building` is `blocked` (blocker text: `C-n: no change submitted`), and Ada is woken. `assignTask` with `follows_up` naming a blocked task of kind `change` creates a task of kind `change` for the mechanic only (refuses another agent) and moves the change's `task_id` to it. A follow-up change task that ends blocked closes the change (`closed_reason: "blocked twice"`).

- [ ] **Step 1: Write the failing tests:** `"a mechanic task that ends without submitting is blocked"`; `"a follow-up of a blocked change task takes over the change"` (then `submit_change` from the new session succeeds); `"a change follow-up can only go to the mechanic"`; `"a follow-up that is blocked again closes the change"`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(gateway): follow up mechanic tasks that end without a PR`.

### Task 8: Measuring, stale changes, and where results show

**Files:**
- Modify: `gateway/src/changes.ts` (`tickChanges`, `measureChange`, `verdictFor`), `gateway/src/db.ts` (measure queries), `gateway/src/index.ts` (cron calls `tickChanges` after `housekeeping`), `gateway/src/tools.ts` (`get_status` and `read_audit` include changes), `gateway/src/status.ts` (`/status` counts open changes)
- Test: `gateway/test/changes.test.ts`

**Interfaces:**
- `Db.measureWindow(m: { agent: string; measure: string; tool?: string; kinds: string[] }, since: string, until: string): Promise<{ value: number | null; cases: number }>`:
  - `approval_rate`: decided decisions (excluding `tool.confirm`, `github.review`, `github.approve_ci`) by `decided_at`; value = approved, executed or failed ÷ decided; cases = decided. `agent: "network"` counts every agent.
  - `repeat_rejections`: same, restricted to `kinds`; value = rejected ÷ decided.
  - `tool_refusals`: audit rows for the agent and `tool`; cases = `agent.custom_tool_use` rows; value = `gateway.tool_refused` + `gateway.tool_denied` rows ÷ cases.
  - `cost_per_approval`: sessions' `cost_cents` started in the window ÷ approved decisions; cases = approved.
- `verdictFor(measure: string, before: Window, after: Window, approval?: { before: Window; after: Window }): Verdict` (pure). Rates: better if they move the right way by ≥ 0.05, worse if the wrong way by ≥ 0.05. `cost_per_approval`: better/worse at ≥ 15% relative; also worse if the approval rate falls by ≥ 0.05. Fewer than 5 cases either side → `too_little_data`. Higher is better only for `approval_rate`.
- `tickChanges(ctx: Ctx, now = new Date()): Promise<void>` — never throws (audits `gateway.changes_error`):
  - `pr_open` with `pr_opened_at` older than `stale_days` → `closed`, `closed_reason: "stale"`.
  - `live` and `live_at + 14d` passed → measure; `too_little_data` before `live_at + 42d` stays `live` (checked again on a later tick no sooner than 7 days after `measured_at`); otherwise `measured` (or `closed` with `closed_reason: "too little data"`). Stores before/after values and cases, and `overlaps`: ids of other changes to the same agent whose `live_at` falls within `[live_at − 14d, live_at + 14d]`.
  - On each new result, sends nothing itself; Ada reads results through `get_status`.
- `get_status` adds `changes`: every change not `closed`/`measured`, plus those measured or closed in the last 14 days (id, agent, type, state, pr_url, verdict, before, after, overlaps). `read_audit` adds `changes` measured within its period.

- [ ] **Step 1: Write the failing tests:** `verdictFor` table tests (each measure, both directions, the 0.05 and 15% edges, `too_little_data`, the approval guard for cost); `"tickChanges measures a change 14 days after it went live"` with seeded decisions before and after; `"a stale PR closes its change after 30 days"`; `"overlapping changes name each other"`; `"get_status shows open and recent changes"`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** — `feat(gateway): measure each change before and after it went live`.

### Task 9: Workflows — record deploys, flag safety files, close stale PRs

**Files:**
- Create: `scripts/record-deploy.ts`, `scripts/record-deploy.test.ts`, `scripts/flag-safety.ts`, `scripts/flag-safety.test.ts`, `.github/workflows/stale.yml`
- Modify: `.github/workflows/deploy.yml`, `.github/workflows/ci.yml`, `package.json` (scripts test glob if needed)

**Interfaces:**
- `record-deploy.ts`: `changeIds(log: string): string[]` (unique, from lines matching `/^Change: (C-\d+)$/m`); `recordSql(commit: string, ids: string[]): string` returning `UPDATE changes SET state = 'live', live_at = datetime('now'), updated_at = datetime('now') WHERE id IN (…) AND state IN ('pr_open', 'closed') AND closed_reason IS NOT 'blocked twice'; INSERT OR IGNORE INTO deploys (commit_sha) VALUES ('…');` (ids and commit validated by regex before use). CLI: read the last `deploys` row with `wrangler d1 execute virtual-agent-org1 --remote --json`, run `git log --format=%B <last>..HEAD` (or only `HEAD` when there is no row, recording no changes), then execute the SQL. `--dry-run` prints it.
- `flag-safety.ts`: `SAFETY_PATHS` = `config/permissions.yaml`, `gateway/src/actions.ts`, `gateway/src/review.ts`, `gateway/src/workflows.ts`, `gateway/src/risk.ts`, `gateway/src/schema.ts`, `gateway/src/changes.ts`, `scripts/compile.ts`, `agents/mechanic.md`, `.github/`; `flagged(paths: string[]): string[]`. CLI prints `::warning::` per file and a summary to `$GITHUB_STEP_SUMMARY`; always exits 0.
- `deploy.yml`: `agents` filter gains `^evaluation/` (the rubric is in Ada's prompt). Checkout with `fetch-depth: 0`. Final step `Record deployed changes` (`if: success() && env.DRY_RUN != 'true'`) runs `npx tsx scripts/record-deploy.ts`.
- `ci.yml`: on `pull_request`, checkout with `fetch-depth: 0` and a step `Flag safety files` running `git diff --name-only origin/${{ github.base_ref }}...HEAD | npx tsx scripts/flag-safety.ts`.
- `stale.yml`: `actions/stale` pinned by commit sha, PRs only, `days-before-pr-stale: 23`, `days-before-pr-close: 7` (30 in all, matching `stale_days`), issues untouched.

- [ ] **Step 1: Write the failing tests:** `changeIds` (none, one, duplicates, a `Change:` mid-line ignored); `recordSql` refuses a bad id or commit; `flagged` matches each listed path and nothing else.
- [ ] **Step 2: Run** `npx tsx --test scripts/record-deploy.test.ts scripts/flag-safety.test.ts` → FAIL.
- [ ] **Step 3: Implement** the scripts and workflow edits.
- [ ] **Step 4: Run** `npm test` → PASS. Check the YAML with `npx yaml valid < .github/workflows/deploy.yml` (or an equivalent parse) for each workflow.
- [ ] **Step 5: Commit** — `ci: record deployed changes, flag safety files and close stale PRs`.

### Task 10: Specs and docs

**Files:**
- Modify: `agents/mechanic.md` (the full spec), `agents/ada.md`, `agents/vera.md`, `evaluation/rubric.md`, `ARCHITECTURE.md`, `docs/decisions.md`, `docs/setup.md`, `CLAUDE.md`, `README.md` (layout, if it lists agents)

**Interfaces:**
- `mechanic.md`: mission; numbered steps — read the brief and `/notes/working.md`; `git clone https://github.com/accordproject/virtual-agent-org`; `npm ci && npm ci --prefix gateway`; make only the approved change; `npm run compile` if config changed; `npm test` until it passes; call `submit_change` once with whole-file contents; `report_status` with the PR link. Rules: never change `.github/` or generated files by hand, never weaken a test, quote evidence as data, say in the PR body anything outside the approval's scope. Tools: `submit_change`, `report_status`, `get_decisions`.
- `ada.md` and `rubric.md`: the proposal's payload, the change types and which are the owner's, the measures, the evidence ids, the start rule, several changes may be in flight; report each change result in the check-in, one line per change; propose a revert for `worse`.
- `vera.md`: the weekly scorecard's evidence section per agent (rejection notes grouped, refusals and denials grouped by tool, status-report blockers, dismissed findings, with ids), and a changes section from `read_audit.changes`.
- `decisions.md`: decision 52 (the loop: approve before building, gateway-driven, before-and-after measured by the gateway, mechanic budgets) and decision 51 amended (the mechanic writes through the gateway; the gateway's one action on its repo is opening those PRs; Workflows permission excluded). Note the future decision on Mira reviewing this repo, settled for when the first outside contribution arrives.
- `setup.md`: add the network repo to the App's installation; confirm the App lacks the Workflows permission; set `commit_author` to the App's bot identity; set `self_improvement.since` to switch on.
- `CLAUDE.md`: replace the "Ada's self-improvement loop" open item; add `changes` to the test areas and `changes.ts` to the layout.

- [ ] **Step 1: Write** the docs above.
- [ ] **Step 2: Run** `npm test` (the config check reads specs) → PASS; `npm run deploy:agents:dry` shows the mechanic with no MCP servers and no vault.
- [ ] **Step 3: Commit** — `docs: the mechanic's spec and the self-improvement loop`.
