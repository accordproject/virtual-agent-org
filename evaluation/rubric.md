# Weekly evaluation rubric

Ada evaluates every active agent each Friday using Vera's weekly scorecard only.
Each dimension is scored 1–4. Evidence is required for every score.

| Dimension | 4 | 3 | 2 | 1 |
| --- | --- | --- | --- | --- |
| **Impact** — movement in the agent's KPIs against its stated objectives | Clear improvement beyond normal variation | Some improvement | Flat | Worse, or no data |
| **Quality** — Matt's decision outcomes and rework | ≥ 90% approved without edits; no rework | 75–89% | 50–74% | < 50%, or any public action without a decision id |
| **Cost efficiency** — spend and cost per outcome, model mix | Cost per outcome falling with quality held | Stable | Rising without quality gain | Over budget or anomalous spend |
| **Conduct** — follows the protocol | No breaches | Minor (late or thin status reports) | Out-of-role work or unclear reporting | Attempted critical action outside the queue, or ignored a rejection note |

## Proposal (at most one per agent per week)

Pick the single change most likely to improve the lowest score, resting on recurring
evidence from the scorecard's evidence section. Ada and the mechanic are evaluated
and proposed for like everyone else. Typical proposals, with their change type and
measure:

| Proposal | `change_type` | `measure` |
| --- | --- | --- |
| Tighten or clarify the spec where a rejection note recurs | `wording` | `repeat_rejections` or `approval_rate` |
| Move work to a cheaper tier when quality has scored 3+ for two weeks | `tier` | `cost_per_approval` |
| Move work up a tier when quality scored 1–2 and the cause is reasoning, not data | `tier` | `cost_per_approval` |
| Fix a tool agents keep calling wrongly: its description, or split or combine tools | `tool` | `tool_refusals` (name the `tool`) |
| Add or remove a requestable action kind or a tool an agent holds | `permission` (Matt's own) | `approval_rate` |

Retiring an agent whose impact has scored 1–2 for four weeks after its first month is
Matt's decision too: put it to him in the check-in, not as a `spec.change`.

Raise it with `request_action(kind="spec.change", target=<agent or "network">)` and the
payload `{change_type, problem, change, evidence, measure, tool?}`: the exact text
change for `wording`, and 1 to 30 evidence ids (`D-41`, `T-12`, `audit:301`,
`status:17`). `permission`, `integration` and `architecture` are Matt's own decisions
and always high risk. The gateway refuses proposals until the loop is on and the
agent has 10 decided decisions or the loop has run 14 days. Matt decides; if he
approves, the mechanic opens a PR and he merges it. Several changes may be in flight
for one agent; their results then share figures and name each other.

14 days after going live the gateway reports `better`, `same`, `worse` or
`too_little_data`. Score the next week's Impact with the result in mind, and propose
reverting a `worse` change.

## Recording

`record_evaluation(agent, week, scores, evidence, proposal)` with scores as
`{impact, quality, cost, conduct}`.
