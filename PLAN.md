# Accord Project Agent Network: Architecture & Build Plan

The original plan and design, by Matt Roberts, 31 October 2026, with the decisions
taken since. The living copy, with the Phase 0 setup checklist, is the plan document
at https://claude.ai/artifact/1odEag5dPNyCvU7Vya6fLf. Where this file and the code
disagree, the code and `config/` are the truth; update this file to match.

## Summary

Build a ten-agent network on Claude Managed Agents, paid from the monthly API credits that come with a Max plan, steered from a private Telegram bot. You talk only to **Ada**, the Chief of Staff. She plans, delegates and reports, but holds no write tools: every side effect goes through a named specialist, and anything critical lands in a decision queue you clear from Telegram.

- **Start small.** Phase 1 runs Ada plus three agents (Maintainer Desk, Metrics, Meetings) against the three KPIs you named. Six more join in Phases 2 and 3 only if Phase 1 earns it.
- **Non-blocking approvals.** Critical actions are custom tools that the gateway queues and executes after you approve. The agent gets a ticket number back at once and moves to other work.
- **Agents never grade themselves.** A separate Metrics agent computes time-to-merge, community size and retention from GitHub and Discord. Ada evaluates each agent weekly against those numbers and its cost.
- **Job specs are code.** Each role is a markdown spec in a git repo. Ada proposes spec changes as pull requests; you merge them.
- **Separate from your chat.** Agents run with a Console API key, so they draw on API credits, not your Claude or Claude Code limits.

First useful output: Ada's first check-in in week 2. Full network: about week 8.

## State of the art, right-sized

The field has converged on one pattern: a hierarchical orchestrator over narrow specialists, with a human gate on irreversible actions. What differs is how much autonomy the specialists get and who checks them.

| Finding | Evidence | What it means for Accord |
| --- | --- | --- |
| Company-style hierarchy beats flat agent groups | [OrgAgent (arXiv 2604.01020)](https://arxiv.org/abs/2604.01020) reports hierarchy outperforming flat multi-agent setups and, on one benchmark, cutting token use by about three quarters | Keep one orchestrator (Ada) and one level of specialists. No agent-to-agent chatter outside Ada. |
| The orchestrator should hold strategy, not detail | Practitioners running a Claude chief of staff report the single-agent version drowns in detail within a week; sub-agents should return short summaries ([thread](https://reddit.sentinel-team.org/posts/1uju6d4/snapshots/2026-07-03T03%3A00%3A16.73148Z)) | Specialists return a one-paragraph status and a structured result; Ada never reads raw diffs or transcripts. |
| A reviewer layer gates quality | GitLab's contributor-success lead described a 13-agent chief-of-staff system where one orchestrator delegates and a reviewer gates quality ([AgentCon 2026](https://agntconmcpconeu26.sched.com/event/2RB8D)) | Metrics (Vera) is independent of the agents it measures, and you are the gate on anything public or irreversible. |
| Hosted runtimes now ship the plumbing | Claude Managed Agents provides cron-scheduled deployments with per-run budgets, pause and archive ([docs](https://platform.claude.com/docs/en/managed-agents/scheduled-deployments)); per-tool permission policies with an audit field on every call ([docs](https://platform.claude.com/docs/en/managed-agents/permission-policies)); and multi-agent workflow runs ([docs](https://platform.claude.com/docs/en/managed-agents/workflow-runs)) | Don't build a scheduler, sandbox or credential store. Build only the Telegram gateway and decision queue. |
| Subscription OAuth is not a backend | Anthropic blocked subscription tokens in third-party harnesses during 2026; the compliant route is a Console API key ([VentureBeat](https://venturebeat.com/technology/anthropic-reinstates-openclaw-and-third-party-agent-usage-on-claude-subscriptions-with-a-catch), [ToS explainer](https://autonomee.ai/blog/claude-code-terms-of-service-explained/)) | Max and Team plans now include monthly API credits for the API, Agent SDK and Managed Agents through a linked Console org ([Claude support](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans.md)). That is the route here. |
| Community health has standard measures | CHAOSS defines time to first response, time to close (use the median) and change-request closure ratio, and warns that recruiting gains take 3 to 6 months to show ([CHAOSS](https://chaoss.community/?p=5703)) | Adopt CHAOSS definitions so numbers compare with other projects and survive a change of tooling. |

**Right-sizing.** Accord is a small foundation project with a weekly Tech WG and a handful of active repos. Ten agents at full autonomy would generate more review work than they save. The plan therefore starts with four agents, gives every agent a write budget of zero public actions without approval, and adds roles only when Ada's weekly evaluation shows a measurable gap.

## The team

Ada is the only agent you instruct. She turns your intent into tasks, assigns them, chases them, and reports. She can read everything and write nothing except task assignments and the decision queue.

*(Diagram in the original plan document: agent network · 1 chief of staff, 9 specialists in 3 phases.)*

Specialists report only to Ada and never instruct each other; critical actions go to your queue, not hers.

| Agent | Role | Objective | KPIs Ada scores weekly | Acts through (critical = queued for you) | Default model | Phase |
| --- | --- | --- | --- | --- | --- | --- |
| **Ada** | Chief of Staff | Turn your intent into delegated work; keep you informed and unblocked | Check-ins on time; decisions per check-in you could answer in one line; tasks closed vs opened | Task board, decision queue. No external writes. | Opus | 1 |
| **Mira** | Maintainer Desk | Every PR and issue gets a fast, correct response | Median time to first response; median time to merge; PR closure ratio | GitHub: label, comment, request changes, assign reviewers. **Merge, close, release: queued.** | Sonnet; Haiku for triage | 1 |
| **Vera** | Metrics & Audit | Independent truth on KPIs and agent cost | Data freshness; reconciles with pr-stats baseline | Read-only GitHub, Discord, Vimeo, cost API; writes the scorecard file | Haiku; Sonnet for analysis | 1 |
| **Otto** | Meetings | Every Tech WG has an agenda before and a recording, summary and actions after | Agenda 24h ahead; recording live within 48h; actions tracked to closure | Agenda drafts; Vimeo title, chapters, showcase. **Publishing and invites: queued.** | Sonnet | 1 |
| **Rosa** | Community | Newcomers feel welcomed and find a path to first contribution | New contributors per month; 90-day retention; newcomer time to first reply | Discord and GitHub Discussions replies; good-first-issue curation. **Announcements and DMs to individuals: queued.** | Sonnet; Haiku for welcome triage | 2 |
| **Juno** | Marketing & Docs | Accord's work is visible and its docs are current | Docs PRs merged; doc gaps closed; post reach | Docs PRs via Mira's queue; WordPress drafts; LinkedIn drafts. **Any publish: queued.** | Sonnet | 2 |
| **Sage** | Research | You and the TSC see what matters in legal tech and agentic commerce | Briefs used in decisions or posts; signal-to-noise as you rate it | Web search; writes briefs to the shared store | Sonnet; Haiku to filter feeds | 2 |
| **Kit** | Training & Security | Maintainers and contributors raise quality and security posture | Curriculum modules delivered; OpenSSF Scorecard trend; open security alerts age | Security issues and draft PRs; training material. **Advisories and policy changes: queued.** | Opus for threat review; Sonnet otherwise | 3 |
| **Felix** | Release & CI | Builds stay green and releases ship predictably | CI pass rate; flaky-test count; release cadence | CI config PRs; changelog drafts. **Tags, npm publish: queued.** | Sonnet | 3 |
| **Nell** | Ecosystem & Funding | More adopters, mentors and money | Adopter case studies; GSoC and grant applications filed; partner intros | Drafts only. **Every external email: queued.** | Sonnet | 3 |

Model defaults are a starting point. Vera reports cost per outcome for each agent, and Ada's weekly review proposes moving a task down a tier when quality holds.

## Roles you were missing, and the 10x levers

Four roles were missing from your list. Three are now in the team above; the fourth is folded into Ada.

- **Metrics & Audit (Vera).** Without an independent measurer, each agent reports its own success. This is the most important addition.
- **Release & CI (Felix).** Time to merge is often set by flaky CI and release friction, not reviewer speed.
- **Ecosystem & Funding (Nell).** Adopters, GSoC mentoring slots and grants are what turn contributors into long-term maintainers.
- **Governance clerk.** TSC minutes, elections, CLA/DCO checks and licence hygiene. Ada carries this until it outgrows her; she assigns the writing to Otto.

A 10x better community is not 10x more output. It is a shorter path from first visit to repeat contributor. The levers, roughly in order of impact:

1. **Answer everyone within two business days.** CHAOSS uses this as its example benchmark for first response. Mira and Rosa make it a standing service level, and Vera publishes it.
2. **A curated on-ramp.** Rosa keeps 10 to 15 well-specified good-first-issues open at all times, each with a named human mentor, and follows up with every first-time contributor after their first merge.
3. **A contributor ladder.** Contributor, reviewer, maintainer, with written criteria and CODEOWNERS. CHAOSS recommends growing reviewers rather than pressuring existing maintainers.
4. **Close what won't be merged, kindly.** Mira proposes closures with a reason; stale PRs are the commonest reason first-timers don't return.
5. **Make the Tech WG findable.** Otto turns each recording into chapters, a written summary and tracked actions, so people who can't attend can still take part.
6. **Turn adopters into contributors.** Nell runs an adopter showcase and asks each adopter for one maintainer-hour a month.
7. **Teach, then check.** Kit's curriculum pairs each module with a measurable change, such as Scorecard checks passing or signed commits enabled.

The CHAOSS guide warns recruiting gains take 3 to 6 months to show. Judge levers 2, 3 and 6 on that horizon, not weekly.

## Architecture

Three parts: agents run on Claude Managed Agents, a small gateway you own connects them to Telegram and holds the decision queue, and a git repo holds every job spec and config.

| Component | What it is | Why this choice |
| --- | --- | --- |
| Agent runtime | One Managed Agent per role, each with its own environment, tools and vault. Recurring work runs as scheduled deployments with a per-run budget. | Scheduler, sandbox, credential vault, pause/archive and audit come built in. Runtime is billed at $0.08 per active session-hour, idle time free ([pricing summary](https://www.truefoundry.com/blog/claude-managed-agents-pricing)). |
| Billing | Console org linked to your Max 20x plan; one API key for the gateway and one for deploys. | Draws on the plan's monthly API credits (Max 20x: $200) and never on your chat or Claude Code limits. Requests pause when credits run out unless you add paid credits. |
| Gateway | A small service (Cloudflare Worker + D1 database) that receives Telegram webhooks, routes your messages to Ada, executes approved critical actions, and streams agent events to an audit log. | Telegram bots need a webhook endpoint anyway. Keeping critical credentials here, not in agent sandboxes, is what makes approvals enforceable. |
| Decision queue | A table in the gateway: id, agent, action, payload, risk, deadline, status. | Agents queue and move on; you clear the queue from Telegram buttons. |
| Org repo | `virtual-agent-org` repo: one markdown job spec per agent, `models.yaml`, permissions, schedules, evaluation rubric. Deployed by CI. | Every change to the network is a reviewed PR with history. |
| Shared memory | A Managed Agents memory store per agent plus one shared read-only store (Accord context, glossary, people, style guide). | Agents keep their own working notes; shared facts have one owner. |
| Model routing | `models.yaml` maps each task type to a model tier. Agents never hard-code a model. | Swapping to a router later is a config and runtime change, not a rewrite of the specs. |

**How a critical action flows without blocking.** Critical actions (merge, publish, post, email, delete, release) are not given to agents as tools. Instead each agent has a custom tool, `request_action`, executed by the gateway:

1. Mira decides PR #812 is ready and calls `request_action(merge, #812, rationale, risk=medium)`.
2. The gateway stores it and immediately returns "queued as D-41". Mira moves on to the next PR.
3. Telegram shows you D-41 with the rationale, a link and buttons: Approve, Reject with note, Ask Ada.
4. On approval the gateway merges with its own scoped token, logs it, and posts the result to Mira's next session.
5. Rejections carry your note back to the agent as feedback, which Vera counts in the weekly evaluation.

As a backstop, every MCP tool that writes externally is set to `always_ask` in the Managed Agents permission policy, so an agent that finds another way to write will pause rather than act.

**Telegram control surface.** A private bot that answers only your Telegram user ID.

- Plain messages go to Ada.
- `/queue` lists open decisions; `/status` shows each agent's last run, spend this week and open tasks.
- `/ask mira …` talks to one agent directly, logged to Ada.
- `/pause <agent>`, `/resume <agent>`, `/stop all` (see Governance).

For TSC members later: add a forum-style Telegram group with one topic per agent, and an allowlist with two roles. **Owner** (you) can approve and pause. **TSC member** can ask questions, see `/status` and comment on decisions, but not approve.

## Governance: watch, stop, revoke, intervene

Every agent has its own identity, so you can see and stop one without touching the others.

**Identity per agent.** Each agent is its own Managed Agent with its own vault and its own GitHub credential, scoped to what its role needs. Mira's token can comment and label; it cannot merge or push. The gateway's app holds merge and release rights.

**Monitoring.**

- Every tool call carries an `evaluated_permission` field (allow, ask or deny). The gateway logs the full event stream per agent into an append-only audit table.
- The Console's session view gives step-level traces and token cost per session.
- Vera flags anomalies daily: spend above 150% of an agent's weekly median, a tool denial, a rejected decision, or a public action without a decision id.
- `/status` in Telegram shows each agent's last run, spend and open tasks.

**Stopping and revoking**, fastest first:

| Lever | Command | Effect | Time to effect |
| --- | --- | --- | --- |
| Pause one agent | `/pause mira` | Gateway pauses that agent's scheduled deployments and stops routing tasks to it. Running sessions finish. | Seconds |
| Hard stop | `/stop mira` or `/stop all` | Also interrupts running sessions and rejects that agent's open decisions. | Seconds |
| Revoke access | `/revoke mira` | Gateway marks the agent revoked, interrupts its sessions and archives its vault, purging its credentials; you uninstall its GitHub App or delete its token. Archiving a vault pauses any deployment that uses it. | Minutes |
| Spending cap | Automatic | Per-run budget on each deployment; the session pauses at the cap. Credits exhausted means all requests pause. | Immediate |

**Intervening without stopping.** Reject a decision with a note; the note goes to the agent as an instruction. `/ask <agent>` lets you correct course directly. For a lasting change, edit the agent's spec in the org repo; new sessions pick it up, running ones keep their old configuration.

**What always needs you.** Merges, releases, anything published or posted, any message to a named person outside the network, deletions, spending, spec and permission changes, and anything an agent rates high-risk. Agents may draft all of these freely.

## Metrics, evaluation and check-ins

The baseline is [ap-stats](https://mttrbrts.github.io/ap-stats/), covering 3 August 2025 to 3 August 2026. Averages improved sharply, but the slowest tenth of PRs got much worse, and only about one in six contributors came back.

| Network KPI | Baseline (Aug 2025 to Aug 2026) | Proposed 6-month target | Owner |
| --- | --- | --- | --- |
| Time to merge, mean | 14.0 days (n=695) | 7 days | Mira, Felix |
| Time to merge, P90 | 42.1 days | 21 days | Mira |
| Time to first response, mean | 7.7 days (n=1,019) | 2 business days | Mira, Rosa |
| Time to first response, P90 | 23.6 days | 5 days | Mira, Rosa |
| Contributor retention (prior-year contributors who returned) | 17.4% (16 of 92) | 30% | Rosa |
| Community size (unique contributors, rolling 12 months) | Not reported; Vera to compute | Set after first count | Rosa, Nell |

Targets are proposals for you to set. The P90 figures matter most: they are the experience of the contributors most likely to leave.

**Baseline fixes Vera makes in week 1.**

- Add medians alongside means, as CHAOSS recommends.
- Exclude bots from people metrics; bots were 26.4% of PRs in the current window.
- Reconcile new-contributor counts: one chart shows 82 while the findings cite 192, and the new-contributors chart repeats the releases figures.
- Relabel the year axes, which read 2024/2025 for an Aug-to-Aug window.
- Extend the window to the present and refresh it weekly, so agent effects show from day one.

**Weekly evaluation (Fridays).** Vera builds the scorecard; Ada judges it. For each agent Ada records:

1. **Impact:** movement in its KPIs against its objective, with Vera's numbers.
2. **Quality:** your decision outcomes (approved, approved with edits, rejected) and any rework.
3. **Cost efficiency:** spend, tokens and dollars per outcome (per merged PR, per published recording), and model mix.
4. **Feedback:** your rejection notes, plus a short self-report from the agent on what blocked it.
5. **Proposal:** at most one spec change per agent, raised as a PR to the org repo, for example "move PR triage from Sonnet to Haiku; quality held for two weeks".

Spec PRs land in your decision queue. Ada never changes a spec or permission herself.

**Check-ins every two days.** A scheduled deployment wakes Ada at 07:30 London time every other day. She asks each active agent for a status, reads Vera's latest numbers, and sends you one Telegram message:

- **Headline:** one line on the network.
- **Per agent:** done, doing, blocked; one line each.
- **KPIs:** movement since the last check-in.
- **Spend:** credits used and forecast for the month.
- **Decisions waiting:** in your numbered format, oldest first.
- **Issues:** anything Vera flagged.

## Build plan

Four phases over about eight weeks. Each phase ends at a gate; nothing new is switched on until the gate passes.

The step-by-step manual setup for Phase 0 is the "Setup checklist" tab of the plan document.

### Phase 0: Foundations (week 1)

- Link a Console org to the Max plan; create one workspace and a spend limit for it.
- Create the `virtual-agent-org` repo: spec template, `models.yaml`, `permissions.yaml`, evaluation rubric, CI that deploys specs to Managed Agents.
- Build the gateway: Telegram webhook with user-ID allowlist, decision queue, `request_action` executor, audit log, `/status /queue /pause /stop /revoke`.
- Register GitHub Apps: a read-only app per agent, plus one gateway app with merge and release rights, installed on a sandbox repo first.
- Write the shared context store: Accord mission, repos, TSC members, Tech WG cadence, tone of voice.

**Gate:** a test agent in the sandbox repo queues a merge, you approve it in Telegram, the gateway merges it, and `/stop` halts the agent within seconds.

### Phase 1: Core loop (weeks 2 to 4)

- **Vera:** reproduce the ap-stats baseline with the fixes above; publish a weekly scorecard.
- **Mira:** triage and first-response on all open PRs and issues; propose merges and closures through the queue.
- **Otto:** agenda for the next Tech WG; after it, Vimeo title, chapters and summary, publishing through the queue.
- **Ada:** every-other-day check-ins and the first Friday evaluation.

**Gate:** two weeks of check-ins on time; at least 80% of Mira's merge proposals approved without edits; no public action without a decision id; spend inside the monthly credits.

### Phase 2: Community and voice (weeks 5 to 7)

- **Rosa:** newcomer welcome, good-first-issue curation, follow-up after first merge.
- **Juno:** docs gap list and docs PRs; WordPress and LinkedIn drafts for each Tech WG and release.
- **Sage:** weekly brief on legal tech and agentic commerce.
- Brief the TSC on the network and its disclosure label before Rosa or Juno speaks in public.

**Gate:** newcomer first-response median under 2 business days; you approve most Juno drafts with light edits.

### Phase 3: Depth (week 8 onwards)

- **Kit:** security baseline (OpenSSF Scorecard per repo), then a curriculum with one measurable change per module.
- **Felix:** CI flake report, release checklist, changelog drafts.
- **Nell:** adopter list, GSoC mentoring plan, one grant application.
- Open the read-only TSC channel in Telegram if the TSC wants it.

**Gate:** each new agent shows KPI movement within four weeks, or Ada proposes retiring it.

## Decisions

Twenty-two decisions; twenty-one settled. Updated 1 November: only decision 10 (paying after the Max plan ends) is open, and it can wait.

**1. Which Claude plan pays for the agents** · RESOLVED: Max 20x

- **What changed:** you have a Max 20x plan for the next four months, so the agents get $200 a month of API credits through a linked Console org. Setup step 1 links it.

**2. Where the agents run** · DEFAULT A

- **Stake:** the hosted runtime saves weeks of plumbing but runs only Claude models, which matters if you later want a router across model vendors.
- **A.** Claude Managed Agents. Cost: $0.08 per active session-hour plus tokens. Next: build only the gateway.
- **B.** Self-hosted Claude Agent SDK on a small server. Cost: about two extra weeks building scheduling, sandboxing and credential storage. Next: router-ready from day one.
- **C.** Claude Code headless runs in GitHub Actions. Cost: these runs count as Claude Code usage, not API credits, and are awkward to stop per agent.
- **Recommendation: A.** Speed to a working experiment matters more than vendor flexibility now; specs and `models.yaml` stay portable. Wrong if you decide within three months to route most work to non-Claude models. If you pick B, Phase 0 grows by about two weeks.

**3. GitHub access for agents on the real Accord repos** · RESOLVED: A

- **Decision:** widen each agent's existing fine-grained token to the in-scope repos, after a short note to the other org owners.
- **What changed:** decision 23 replaced the per-repo token lists with all repos.

**4. Who merges** · DEFAULT A

- **Stake:** merge rights decide how far time-to-merge can fall and how much of your attention the queue takes.
- **A.** Every merge goes through your decision queue. Cost: a few taps a day. Next: Mira's approval rate builds a track record.
- **B.** After four clean weeks, auto-merge only dependency and docs PRs with green CI; everything else queued. Next: less queue load.
- **C.** Human maintainers merge on GitHub; agents only review. Next: least risk, least speed gain.
- **Recommendation: A.** It matches your rule that critical actions need you and produces the evidence for B later. Wrong if the queue exceeds about 15 merges a day. If you pick C, Mira's merge KPI moves to Felix and the human maintainers.

**5. Telling the TSC and community that agents are acting** · RESOLVED: A

- **Decision:** you briefed the TSC on Discord on 31 October; agent-drafted public messages carry the agent label, which the gateway now adds automatically to Discord posts.

**6. Six-month KPI targets** · RESOLVED: A

- **Decision:** time to merge mean 7 days and P90 21 days; first response 2 business days and P90 5 days; retention 30%. Recorded in the agents' shared context.

**7. Where the gateway runs** · DEFAULT A

- **Stake:** the gateway holds merge and publish credentials, so where it runs is a security and cost choice.
- **A.** Cloudflare Worker with D1. Cost: free tier at this volume. Next: built in Phase 0.
- **B.** Small VPS. Cost: about £5 a month and patching. Next: more control.
- **C.** Your home machine. Cost: none, but approvals stop when it sleeps.
- **Recommendation: A.** Always on, no server to patch, secrets in the platform's secret store. Wrong if you need long-running jobs in the gateway itself.

**8. How LinkedIn posts get out** · WHENEVER

- **Stake:** LinkedIn's API needs app review for organisation posting, so agents can't post directly on day one.
- **A.** Juno sends finished drafts to Telegram; you post with one copy-paste.
- **B.** Apply for LinkedIn API access for the Accord Project page. Cost: weeks of review. Next: approved posts go out from the gateway.
- **Recommendation: A.** Volume will be a few posts a month. Wrong if Juno's drafts become weekly or more.

**9. Where the code lives** · RESOLVED: Accord Project org

- **What changed:** you chose A, then on 31 October moved both repos to the Accord Project org (`accordproject/virtual-agent-org` and its sandbox). Setup step 6a covers what the move changes.

**10. Paying for the agents after your Max 20x plan ends** · WHENEVER

- **Stake:** your Max 20x plan runs for about four more months; when it ends, the $200 a month of API credits stops and agent requests pause.
- **A.** Renew Max 20x: $200 a month of credits continues.
- **B.** Move to Max 5x: $100 a month of credits.
- **C.** Fund the Console org pay-as-you-go from the Accord Project or a sponsor: the project carries the cost and no personal plan is needed.
- **Recommendation: B.** Four Phase 1 agents, mostly on Sonnet and Haiku, should cost well under $100 a month. Wrong if Vera's January spend figures run above $80 a month.

**11. Which repos the agents work on first** · RESOLVED: A

- **Decision:** Concerto, Template Playground and Template Engine, plus the sandbox for testing the network.

**12. Whose name Mira's direct GitHub actions appear under** · RESOLVED: A

- **Decision:** the agents' tokens come from your second account, `mttrbrts-agent`, with the Triage role on the in-scope repos. Approved actions continue to appear as the `virtual-agent-org-gateway` app.

**13. How Discord users reach the network** · RESOLVED: A

- **Decision:** Discord as a second front door, nobody needs Telegram. The Discord app's bot handles slash commands, approvals and posts (decision 17 retired the webhooks). `config/people.yaml` maps each person's GitHub, Discord and Telegram ids; it grants read-and-ask access only.

**14. Where you approve and control the network** · SUPERSEDED by 15B

- **What changed:** you first chose Telegram-only approvals (A), then asked for approval buttons in Discord too. Decision 15 replaces this one.

**15. What you can do from Discord** · RESOLVED: B

- **Decision:** from Discord you can instruct Ada and approve or reject low- and medium-risk decisions in your DMs. High-risk decisions, paused tool calls, `/resume` and `/revoke` stay Telegram-only; `/pause` and `/stop` work in both. Owner rights on Discord come only from the `OWNER_DISCORD_ID` secret. The risk ceiling is `discord_approval_max_risk` in `config/permissions.yaml`.

**16. What the #agent-ops channel is for** · RESOLVED

- **Decision:** a private Discord channel where agents ping maintainers and TSC members about things that shouldn't be public. Agents request a `discord.ops` post naming people by GitHub login; each one waits for your approval (low risk, so Discord DMs work too). Only people in `people.yaml` with a Discord id can be pinged, never @everyone or a role. Mira uses it to nudge reviewers after 3 days, Otto for meeting actions, and Kit for private security alerts.

**17. How agents reach maintainers and TSC members privately** · RESOLVED: A

- **Decision:** keep #agent-ops as a shared private channel, and have the app's bot post there and to announcements. Both webhooks are retired; channel ids live in `config/discord.yaml`.

**18. How far Otto goes with Vimeo** · RESOLVED: A

- **Decision:** Otto finds new recordings and reads transcripts through the gateway, and drafts title and description in the runbook's format. One approval sets the title and description, then makes the video public last. The Vimeo token is held only by the gateway.
- **What changed (1 November):** the Accord Vimeo account is on the legacy Plus plan, which can't add chapters through the API (every variant returned 404). Chapters now go in the description as timestamp lines. `scripts/vimeo-chapter-probe.sh` re-tests this if the plan changes.

**19. Which app approval cards go to** · RESOLVED: A

- **Decision:** cards you can approve in Discord (medium risk and below) go only to Discord, with the full content in embeds. High-risk cards and paused tool calls stay on Telegram. If Discord can't deliver a card, it goes to Telegram. Set by `approvals_app` in `config/permissions.yaml`.

**20. Whether Mira's CI approvals need you** · RESOLVED: A

- **Decision:** after reviewing a fork PR's diff for risk, Mira approves its waiting CI runs herself (`github.approve_ci`, the only `auto` action kind). The gateway checks the PR's files and queues the request for you as high risk if it touches workflows, build scripts, dependency or lock files, Dockerfiles or shell scripts, and refuses if commits arrived after her review. Checked on 1 November: none of the three repos' workflows use `pull_request_target` or self-hosted runners; if that changes, revisit.

**21. Structured briefs and effort budgets** · RESOLVED: B

- **Decision:** from the coordination research (below), Ada's `assign_task` requires an objective, output, "done when" test and effort level. Effort sets the session cap and a tool-call target: small $0.30 / ~10 calls, medium $1 / ~30, large $3 / ~80. The independent review check (decision 22) followed straight away; Ada's self-improvement loop waits for two weeks of decisions to test against.

**22. How Mira reviews PRs** · RESOLVED: A

- **Decision:** review is its own scheduled pass (weekdays 10:00 and 15:00, up to three PRs). Mira drafts findings with severity and confidence after reading the repo's AGENTS.md and CONTRIBUTING.md, then hands the draft to a fresh session that verifies each finding, posts only confirmed ones, and alone may propose the merge (`review_check_required`). PRs over 200 changed lines are checked on the deep tier. Triage records whether maintainers act on each finding; on Fridays Mira turns repeated lessons into an AGENTS.md update PR (`github.docs_pr`, approval-gated, then normal maintainer review), so every reviewer benefits.

**23. Which repos the agents' tokens cover** · RESOLVED: C

- **Decision:** read-only tokens (Vera, Otto) cover all Accord Project repos; tokens that can write (Mira now, Rosa later) list only the repos in scope, so direct writes stay within `github.repos` in `config/network.yaml`. Adding a repo is `npm run repo:add`, which checks the GitHub side and reminds you which tokens to edit. Wrong if a read-only agent's token turns out to have write permissions.
- **What changed:** you first chose all repos for every token (A); the threat analysis and decision 24 (GitHub tool left open) moved it to C on 1 November.

**24. Whether agents' GitHub tool may write directly** · RESOLVED: B

- **Decision:** the GitHub MCP tool stays open (`always_allow`); agents' direct writes are limited by their tokens and instructions, not by the tool configuration. So rule 2 isn't enforced for direct GitHub comments and new issues, only by the agents' specs. Reason: agents are to become more autonomous in a later phase.

**25. Personal data before making this repo public** · RESOLVED: A

- **Decision:** Discord and Telegram ids leave the repo. They live in the git-ignored `config/people.ids.yaml`, keyed by name, and `npm run people:ids` loads them into the gateway's `PEOPLE_IDS` secret; `people.yaml` keeps names, roles and GitHub logins. The repo is published with a single fresh first commit, so the ids in the current history never become public.

**26. The Tech WG Zoom link in the shared context** · RESOLVED: B

- **Decision:** the joining link, with its password, stays in `context/accord.md`; it is already public.

**27. How the repo goes public** · RESOLVED: B

- **Decision:** after the id change is merged and deployed, replace `main`'s history with one signed-off commit and make this repo public; the URL and settings stay. `main` is the only branch, there are no tags or forks, so nothing else holds the old history. Old commits may stay reachable by SHA for a while; GitHub Support can purge them if that matters later.

## Changes since the plan (1 November)

- **Memory between sessions.** Each agent reads and rewrites `/notes/working.md` in its own memory store; chat history doesn't carry across sessions. A conversation moves to a fresh session at 80% of its budget.
- **Otto's runbook** (from `accordproject/vimeo-summary`) is built into `agents/otto.md`, including the quarterly review draft.
- **Chair's briefing.** Every Tuesday at 10:00 Otto drafts Diana Lease's briefing for Wednesday's Tech WG; approval sends it as a Discord DM. `message.person` is now delivered as a Discord DM to anyone in `people.yaml` with a Discord id, and falls back to a manual send otherwise.
- **No duplicate replies.** `send_to_matt` is refused inside a conversation with Matt, where his reply already reaches him.

## Coordination research (1 November)

What industry evidence says, and where the network stands:

- **Command and control:** a central coordinator contains errors (4.4× amplification against 17.2× uncoordinated, [Google Research](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/)), and writes should stay single-threaded ([Cognition](https://cognition.com/blog/multi-agents-working)). Ada at the hub and the gateway as the only writer match this.
- **Communication:** briefs need an objective, output format, tool guidance and boundaries; workers return short summaries ([Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)). Decision 21.
- **Session length:** short sessions plus external notes beat long chats; keep system prompts and tool lists stable so prompt caching works (41–80% cost savings, [study](https://arxiv.org/html/2601.06007v2)).
- **Budgets:** explicit effort scaling stops overspending; a strong lead with cheaper workers beat a single strong agent by 90%.
- **Team size:** effective team size saturates fast ([Ringelmann study](https://pith.science/paper/2606.02646)) and groups average away their expert ([Pappu et al.](https://www.alphaxiv.org/abs/2602.01011)). Ten non-voting specialists avoid this; add roles only when one is overloaded.
- **Verification:** about a quarter of multi-agent failures are verification failures ([MAST](https://arxiv.org/html/2503.13657v3)); independent, fresh-context review fixes most. Decision 22.
- **Self-improvement:** agents can diagnose failures and rewrite their prompts and tool descriptions; start with ~20 eval cases and an LLM judge. Next: Ada turns rejection notes into spec-change PRs tested against past decisions.

Sources: [Claude support: monthly API credits](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans.md) · [Managed Agents permission policies](https://platform.claude.com/docs/en/managed-agents/permission-policies) · [Scheduled deployments](https://platform.claude.com/docs/en/managed-agents/scheduled-deployments) · [Workflow runs](https://platform.claude.com/docs/en/managed-agents/workflow-runs) · [Managed Agents pricing (TrueFoundry)](https://www.truefoundry.com/blog/claude-managed-agents-pricing) · [CHAOSS responsiveness guide](https://chaoss.community/?p=5703) · [OrgAgent](https://arxiv.org/abs/2604.01020) · [ap-stats baseline](https://mttrbrts.github.io/ap-stats/)
