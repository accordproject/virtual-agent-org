# Self-improvement loop: design

Status: draft for the owner's approval, 3 November 2026.

## Why

The network should get a little better each week at what the owner approves. Today the
owner's rejection notes go back to the one agent that was rejected (protocol rule:
"read rejection notes as feedback") and then fade. Ada's Friday evaluation can propose
a spec change, but nothing builds it, nothing records it, and nobody checks whether it
helped. Ada's own KPI already asks for "one evidence-based spec proposal per agent per
week at most, with measured effect".

The loop closes that gap. Evidence (mainly rejection notes) becomes a proposal, the
owner approves the idea, the mechanic builds it as a pull request, the owner merges it,
and two weeks after it goes live Vera reports whether it helped.

## Goals

- Turn recurring evidence into concrete changes: spec wording, model tiers and the
  network's own tools.
- Every change is traceable from evidence to proposal, decision, pull request, deploy
  and measured result.
- The owner spends one card per proposal and one review per pull request, nothing more.

## Non-goals

- Replaying past cases against a proposed spec before it ships. The owner chose a
  before-and-after check instead.
- Automatic merging or deploying. The owner merges on GitHub and approves the deploy
  run (decisions 49 and 51).
- Mira reviewing PRs on this repo. The owner has decided she will once the first
  outside contribution arrives, on tighter terms: review, comment and label only; no
  `auto` kinds here (CI approval goes to the owner); every merge proposal high risk;
  the repo stays out of her write scope. Not built now; it does not change who writes.
- Changing the Accord Project repos. Their AGENTS.md lessons stay with Mira's
  `mira-lessons` pass (decision 22).

## Anti-goals (failure even if it works)

- A change that loosens a safety rule or a gateway check without the owner seeing that
  it does.
- Churn: changes made faster than anyone can tell whether they helped.
- Text from PRs, transcripts or audit rows steering what the mechanic writes (rule 6).
- A queue the owner dreads: more than about one proposal per agent per week.

## Settled by the owner

| What | Choice |
| --- | --- |
| Testing a change | Before-and-after check after it is live, not a replay |
| What the loop may change by pull request | Spec wording (agent specs, `_protocol.md`, the rubric), model tiers, and tools: their descriptions, combining or splitting them, and new tools or abstractions |
| What only the owner decides | New integrations, permissions (including which tools an agent holds), and major architecture changes |
| Who writes the code | The network: the mechanic, the only agent that may propose code for this repo (decision 51) |
| When the owner approves | Before building: the owner approves each proposal, then the mechanic builds it. The owner may relax this later |
| How the change becomes a PR | The mechanic holds no credential; the gateway's App opens the PR after the owner approved the proposal (Mira's `github.docs_pr` model). Decision 51 amended |
| How the loop learns a change is live | The deploy workflow records it; a stale workflow closes unmerged PRs; the gateway never reads this repo |
| The mechanic's budget | $1 a task for wording and tier changes, $5 for tool and owner-only changes |
| Overall shape | The gateway drives it (approach 1 below) |

## Approaches considered

1. **The gateway drives it (chosen).** `spec.change` gets a real executor: approving
   the card assigns the mechanic a task. The gateway records each change and its state;
   Vera computes the before-and-after result. Costs a new executor, a table and the
   mechanic's spec; nothing relies on an agent remembering. Keeps grading independent
   of the agents being changed.
2. **Ada drives it.** Ada tracks proposals in her notes, assigns the mechanic once she
   sees an approval, and asks Vera for figures. Almost no gateway code, but Ada starts
   each session fresh, so proposals can stall or be lost, and approved work waits for
   her next session.
3. **The mechanic does it all.** It reads evidence, proposes, builds and measures.
   Rejected: it takes evaluation from Ada and lets the mechanic grade its own changes.

## How it works

### 1. Evidence (Vera, weekly)

Ada scores agents on Vera's numbers only (rubric), so the evidence reaches her through
Vera's weekly scorecard. Vera adds an **evidence** section per agent, built from
`read_audit` and the decisions table:

- rejection notes, grouped where they say the same thing, with decision ids;
- custom tool calls the gateway refused (missing or invalid fields, decision 31) and
  permission denials (decision 48), grouped by tool and error, with audit row ids;
- tool complaints and blockers from status reports, with status ids;
- for Mira, review findings maintainers dismissed (decision 35 tables).

The rows are quoted as data. Vera summarises; she does not propose.

### 2. Proposal (Ada, Fridays)

In the weekly evaluation Ada may raise at most one proposal per agent, as today, with
`request_action(kind="spec.change", target=<agent>, payload)`. The payload:

| Field | Meaning |
| --- | --- |
| `change_type` | `wording`, `tier`, `tool`, or one of the owner-only types `permission`, `integration`, `architecture` |
| `problem` | What goes wrong, in one or two sentences |
| `change` | The proposed change: exact wording for `wording`, the tier move for `tier`, a description of the tool change for `tool` |
| `evidence` | Ids it rests on: decisions (`D-n`), audit rows, status reports. At least one |
| `measure` | The figure expected to move and in which direction, from a fixed list (below) |

The gateway checks the payload like any other kind (decision 42), and the card shows
every field. Owner-only types are high risk and say so at the top of the card. For the
others, risk follows the files likely touched: `tool` changes are medium, `wording`
and `tier` low.

Ada also raises one for herself and for the mechanic: neither is exempt. A proposal
about the mechanic's own spec or permissions is high risk.

Guards in the gateway:

- **Several changes may be in flight** for one agent (owner's decision). When two
  overlap in their measuring windows, each result names the others, so Ada and the
  owner can see the figures are shared.
- **Enough evidence to start.** Refused until the agent has at least 10 decided
  decisions or 14 days of activity since the loop was switched on (my call: the "about
  two weeks of real decisions" the owner set).

### 3. Build (the gateway, then the mechanic)

`spec.change` changes from `manual` to a new executor, `task`. When the owner approves:

1. The gateway records a change (`C-n`) linked to the decision and creates a mechanic
   task. The brief comes from the approved payload, plus fixed boundaries: change only
   what the decision approved, cite the decision and evidence, never touch files
   outside the approval's scope without saying so.
2. The session budget is the mechanic's own, in `config/network.yaml`
   (`budgets.mechanic_task_usd`): $1 for `wording` and `tier`, $5 for `tool` and the
   owner-only types (owner's decision). Cloning, installing and running the tests
   costs more than a normal `small` task.
3. The decision is `executed` once the task exists. If the task can't be created, the
   decision is `failed` and decision 50's follow-up applies.

Approving the proposal also authorises the gateway to open the resulting pull request
(step 4). There is no second card: opening a PR merges nothing, and the owner's review
of the PR is the gate.

The relaxation the owner may want later (build without approving first) is making
`spec.change` an `auto` kind. That stays the owner's decision: `compile.ts` allows
`auto` only for kinds in `AUTO_KINDS`.

### 4. The mechanic, and how its change becomes a pull request

A new agent, called the mechanic here (agent id `mechanic` until the owner names it).
Phase 1, deep tier for `tool` and owner-only types, standard otherwise (set per task).

The mechanic holds **no GitHub credential** (owner's decision, following the model of
Mira's `github.docs_pr`). The repo is public, so its sandbox clones it without one.

- **Spec** (`agents/mechanic.md`): read the brief; clone `main`; make the change; run
  `npm test`; call `submit_change`; report status. One submission per change. Never
  edit `deployed.json` or `network.json` by hand (regenerate them), never weaken a
  test to make it pass, never change files under `.github/workflows/`.
- **Tools:** `read`, `write`, `edit`, `glob`, `bash`; custom tools `submit_change`
  and the standard `report_status`, `get_decisions`. No MCP servers. `requestable: []`.
- **`submit_change(change, files, title, body)`:** the changed files as whole
  contents (and deletions), a Conventional Commits title, and a body. The gateway
  accepts it only from the session of the task it created for that change, only while
  the change is `building`, and only once. It refuses paths under `.github/`, with
  `..`, or outside the repo. Then the gateway's GitHub App commits the files to a
  branch `change/C-n` from `main`, with a DCO sign-off in the App's name, and opens
  the PR. The body is prefixed with the change id, decision id, evidence ids and
  measure, and text quoted from evidence is marked as quoted. The change moves to
  `pr_open`.
- **The App's reach here:** the App is installed on this repo. It must not hold
  GitHub's Workflows permission, so it cannot change CI or the deploy workflow; those
  stay with the owner. `repo:add`'s checks don't apply, since this repo never enters
  `github.repos`.

**Flagging:** a CI check on every PR (a workflow step, no agent credential) reports
when a PR touches `config/permissions.yaml`, the gateway's checks (`actions.ts`,
`review.ts`, `workflows.ts`, `risk.ts`, `schema.ts`), `compile.ts`, or the mechanic's
own spec, so the owner looks closer (decision 51). It flags rather than fails: after
the owner decides a permissions question, the mechanic must be able to write it.

### 5. Keeping every other agent out

Only the mechanic can propose code here, and only for a change the owner approved:

1. **Only the mechanic can submit.** `submit_change` is owned by the mechanic; the
   gateway knows the caller from its session, not from anything the agent says.
2. **Every other action refuses this repo.** The repo can never be in
   `github.repos` (`compile.ts` refuses it), and every action kind (merge, close,
   comment, `github.docs_pr`, `label_pr`, review) refuses this repo as a target in code,
   even if the config check were bypassed. The pull-request path in step 4 is the only
   write.
3. **Agents' own tokens can't reach it.** Mira's token lists only repos in scope
   (decision 23); Vera's and Otto's are read-only. `compile.ts` refuses this repo in any
   agent's scope.
4. **No approval, nothing to submit.** `submit_change` needs a `building` change and
   the task the gateway created for it.
5. **Only Ada proposes.** `spec.change` is requestable by Ada alone (the config check
   enforces it). Other agents describe problems in status reports, which reach Ada as
   evidence through Vera.
6. **The owner reviews and merges**, with CODEOWNERS on every file and the deploy run
   waiting for approval (decision 49).

What remains is indirect influence: an agent's status reports shaping Ada's
proposal. The card shows the evidence ids, the PR shows the code, and evidence text is
quoted as data (rule 6).

Decision 51 is amended accordingly: the mechanic writes here through the gateway
rather than from a fork, and the gateway's only action on this repo is opening the
mechanic's pull requests.

### 6. Live, then measured

The change moves through these states, all held by the gateway:

`approved → building → pr_open → live → measured`, or `closed`.

The gateway never reads this repo.

- **live:** after each successful run, the `deploy` workflow (decision 49) records in
  the gateway's D1 database which changes it deployed, found from `Change: C-n` lines
  in the commits since the last deploy. The workflow already holds the database
  credential (it runs migrations), so no new secret is needed. The gateway opens each
  PR with that line in the description, so a squash merge carries it. (Not
  `network.json`: CI requires it to match a fresh compile, and a wording-only change
  deploys the agents without redeploying the gateway.)
- **closed:** the repo's stale workflow closes PRs left unmerged, as in other Accord
  repos; the gateway closes a change still `pr_open` after the same number of days.
  A change that ends blocked twice (decision 50: Ada may reassign once, a second
  block goes to the owner) is also closed.
- **measured:** 14 days after going live, the gateway computes the change's `measure`
  for the 14 days before going live and the 14 days after, from its own tables, and
  stores both figures and a verdict: `better`, `same`, `worse`, or `too_little_data`
  (fewer than 5 cases on either side; computed again weekly, up to four weeks, then
  closed as `too_little_data`). A result lists any other change to the same agent
  that went live within its windows. The gateway computes rather than Vera, so no agent
  grades a change to itself, Vera included (my call). Vera's weekly scorecard lists
  the results.

Measures (fixed list, my call). The queue has no "approve with edits", so quality is
the approval rate:

| Measure | Used for |
| --- | --- |
| Share of the agent's decided decisions that were approved | wording |
| Rejections of the decision kinds named in the change's evidence | wording |
| Refused or denied calls to the named tool | tool |
| List cost per approved decision, with the approval rate not falling | tier |

Ada reports each result in her next check-in, one line per change. A `worse` result
leads Ada to propose reverting it in the next weekly evaluation, through the same card.
Nothing is reverted automatically.

## Data

One migration adds `changes`: id (`C-n`), agent, decision id, change type, measure,
state, task id, PR URL, live time, before, after, verdict, timestamps.

`get_status` and the scorecard include open changes; `/status` lists them.

## Config, workflows and docs

- `config/permissions.yaml`: `spec.change` executor `task`; the mechanic's entry.
- `config/network.yaml`: `self_improvement.enabled` (off until switched on), the start
  date used by the evidence guard, and `budgets.mechanic_task_usd`.
- `.github/workflows/deploy.yml`: record deployed changes. A stale workflow for PRs.
  A CI step that flags safety files. (Written by hand, since the App can't change
  workflows.)
- `agents/mechanic.md` (new); `agents/ada.md`, `evaluation/rubric.md`: the payload,
  measures and the overlap note; `agents/vera.md`: the evidence section and the
  change results in the scorecard.
- `ARCHITECTURE.md`: the mechanic in the team and credentials tables; the loop under
  Working rhythm; the gateway's one action on its own repo.
- `docs/decisions.md`: a new decision recording this design, decision 51 amended, and
  the CLAUDE.md open item replaced.
- `docs/setup.md`: installing the App on this repo without the Workflows permission.

## Depends on

- The `feat/ada-follow-up` branch (decisions 49 to 51, follow-ups) merged first.
- The owner installing the gateway's App on this repo and confirming it lacks the
  Workflows permission.

## Left to the builder

- Exact card layout and wording for `spec.change`.
- How Vera groups similar rejection notes.
- How the App commits several files (the Git data API, one commit per change).
- Test coverage, following the repo's conventions (one test file per area, fakes only).
