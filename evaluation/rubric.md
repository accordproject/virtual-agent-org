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

Pick the single change most likely to improve the lowest score. Typical proposals:

- Move a task to a cheaper tier when quality has scored 3+ for two weeks.
- Move a task up a tier when quality scored 1–2 and the cause is reasoning, not data.
- Tighten or clarify the spec where a rejection note recurs.
- Add or remove a requestable action kind.
- Retire an agent whose impact has scored 1–2 for four weeks after its first month.

Raise it with `request_action(kind="spec.change")`, including the exact text change
and the evidence. Matt decides.

## Recording

`record_evaluation(agent, week, scores, evidence, proposal)` with scores as
`{impact, quality, cost, conduct}`.
