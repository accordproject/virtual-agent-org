# Decisions

Settled design decisions for the agent network, in the order they were taken. Code
and config comments refer to them by number ("decision 20"). The owner (the TSC chair)
takes these decisions; a new one gets the next number and is added here in the same
pull request that implements it. [ARCHITECTURE.md](../ARCHITECTURE.md) describes the
result.

Statuses: **RESOLVED** (chosen), **DEFAULT** (the recommendation stands until someone
asks to revisit it), **OPEN**, **SUPERSEDED**.

**1. How the agents are paid for** · RESOLVED

- The agents run on a Claude Console API key and draw on API credits, never on anyone's
  chat or Claude Code limits. Budgets are in `config/network.yaml`.

**2. Where the agents run** · DEFAULT: Claude Managed Agents

- The hosted runtime provides scheduling, sandboxes, credential vaults, pause and audit,
  so only the gateway had to be built. Specs and `config/models.yaml` stay portable.
- Revisit if most work should move to non-Claude models.

**3. GitHub access for agents on the real Accord repos** · RESOLVED

- Each agent has its own fine-grained token. Decision 23 sets which repos each covers.

**4. Who merges** · DEFAULT: every merge goes through the owner's decision queue

- It keeps critical actions with the owner and builds the track record needed before
  any automatic merging is considered.
- Revisit if the queue exceeds about 15 merges a day.

**5. Telling the TSC and community that agents are acting** · RESOLVED

- The TSC was briefed on 31 October 2026. Agent-drafted public messages carry the
  agent's label, which the gateway adds to Discord posts.

**6. Six-month KPI targets** · RESOLVED

- Time to merge: mean 7 days, P90 21 days. Time to first response: 2 business days,
  P90 5 days. Contributor retention: 30%.

**7. Where the gateway runs** · DEFAULT: Cloudflare Worker with D1

- Always on, no server to patch, secrets in the platform's secret store, free at this
  volume. Revisit if the gateway needs long-running jobs.

**8. How LinkedIn posts get out** · DEFAULT: drafts go to the owner, who posts them

- LinkedIn's organisation posting API needs app review. Revisit if drafts become weekly.

**9. Where the code lives** · RESOLVED: the Accord Project organisation

- `accordproject/virtual-agent-org` and its sandbox, `accordproject/virtual-agent-org-sandbox`.

**10. Long-term funding** · OPEN

- Whether the project or a sponsor funds the API credits once the current arrangement
  ends. Vera's monthly spend figures inform it.

**11. Which repos the agents work on first** · RESOLVED

- Concerto, Template Engine and Template Playground, plus the sandbox for testing the
  network. `npm run repo:add` adds more.

**12. Whose name agents' direct GitHub actions appear under** · RESOLVED

- Agents' tokens belong to a dedicated account, `mttrbrts-agent`, with the Triage role
  on the repos in scope. Approved actions appear as the `virtual-agent-org-gateway` app.

**13. How Discord users reach the network** · RESOLVED

- Discord is a second front door alongside Telegram. The Discord bot handles slash
  commands, approvals and posts. `config/people.yaml` lists who may use it, with
  read-and-ask access only.

**14. Where the owner approves** · SUPERSEDED by 15

**15. What the owner can do from Discord** · RESOLVED

- Instruct Ada, and approve or reject low- and medium-risk decisions in DMs. High-risk
  decisions, paused tool calls, `/resume` and `/revoke` stay on Telegram; `/pause` and
  `/stop` work in both. Owner rights on Discord come only from the `OWNER_DISCORD_ID`
  secret. The ceiling is `discord_approval_max_risk` in `config/permissions.yaml`.

**16. What the #agent-ops channel is for** · RESOLVED

- A private Discord channel where agents ping maintainers and TSC members about things
  that shouldn't be public, through approved `discord.ops` posts naming people by
  GitHub login. Only people in `people.yaml` with a Discord id can be pinged, never a
  role or @everyone.

**17. How agents reach maintainers and TSC members privately** · RESOLVED

- The bot posts to #agent-ops and to announcements; channel ids are in
  `config/discord.yaml`. The earlier webhooks are retired.

**18. How far Otto goes with Vimeo** · RESOLVED

- Otto finds new recordings and reads transcripts through the gateway, drafts the
  title and description, and one approval sets them and makes the video public. The
  Vimeo token is held only by the gateway. The account's plan can't set chapters
  through the API, so chapters go in the description as timestamp lines.

**19. Which app approval cards go to** · RESOLVED

- Cards that can be approved in Discord go only to Discord; high-risk cards and paused
  tool calls stay on Telegram. If Discord can't deliver a card, it goes to Telegram.
  Set by `approvals_app` in `config/permissions.yaml`.

**20. Whether Mira's CI approvals need the owner** · RESOLVED: no, with gateway checks

- After reviewing a fork PR, Mira approves its waiting CI runs (`github.approve_ci`,
  the first `auto` action kind; decision 36 added `github.review`). The gateway sends the request to the owner as high
  risk if the PR touches workflows, build scripts, dependency or lock files,
  Dockerfiles or shell scripts, and refuses if commits arrived after the review.
- This assumes no in-scope repo uses `pull_request_target` or runners that aren't
  GitHub-hosted; `npm run repo:add` checks that for each new repo.

**21. Structured briefs and effort budgets** · RESOLVED

- Ada's `assign_task` requires an objective, output, a "done when" test and an effort
  level. Effort sets the session cap and a tool-call target: small $0.30 / ~10 calls,
  medium $1 / ~30, large $3 / ~80.

**22. How Mira reviews PRs** · RESOLVED

- Review is its own scheduled pass. Mira drafts findings after reading the repo's
  AGENTS.md and CONTRIBUTING.md; a fresh session verifies each finding, posts only
  confirmed ones, and alone may propose the merge (`review_check_required`). PRs over
  200 changed lines are checked on the deep tier. Repeated lessons become AGENTS.md
  update PRs (`github.docs_pr`, approval-gated).
- Decision 35 replaced the 200-line rule with the gateway's risk band, and decision 36
  moved posting to the gateway.

**23. Which repos the agents' tokens cover** · RESOLVED

- Read-only tokens (Vera, Otto) cover all Accord Project repos. Tokens that can write
  (Mira, later Rosa) list only the repos in scope, so direct writes stay within
  `github.repos` in `config/network.yaml`.
- Wrong if a read-only agent's token turns out to have write permissions.

**24. Whether agents' GitHub tool may write directly** · RESOLVED: yes

- The GitHub tool is `always_allow`; direct writes are limited by tokens and
  instructions, not by tool configuration, so the decision queue does not cover direct
  GitHub comments and new issues. Agents are to become more autonomous in a later phase.

**25. Personal data in the repo** · RESOLVED

- Discord and Telegram ids live in the git-ignored `config/people.ids.yaml`, keyed by
  name, and `npm run people:ids` loads them into the gateway's `PEOPLE_IDS` secret.
  `people.yaml` keeps names, roles and GitHub logins.

**26. The Tech WG joining link in the shared context** · RESOLVED

- It stays in `context/accord.md`; it is already public.

**27. How the repo went public** · RESOLVED

- The private history was replaced with one signed-off commit before the repo was made
  public, so earlier personal data was never published.

**28. Design documents** · RESOLVED

- The original private plan was split into [ARCHITECTURE.md](../ARCHITECTURE.md) and
  this log. The owner's working notes stay outside the repo.

**29. Licence** · RESOLVED: Apache-2.0 for everything

- Agent specs are instructions run by a model and are licensed like the code.

**30. Who reviews changes** · RESOLVED

- `.github/CODEOWNERS` makes the owner the reviewer for every file, matching the rule
  that agents only propose changes. Revisit when someone else maintains the gateway.

**31. How agents' reports of tool problems reach the owner** · RESOLVED: no new route yet

- Agents' tool complaints reach the owner only through status reports and Ada's
  check-in. Calls the gateway rejects (a missing or invalid field) are answered with
  an error but not flagged in the audit log.
- Revisit with the self-improvement loop, which will read status reports and the
  audit log for evidence.

**32. How Mira starts work** · RESOLVED: on a schedule

- Mira keeps her scheduled passes rather than reacting to GitHub webhooks. Each
  session has a fixed start-up cost, which a pass spreads across many items.
- Revisit if first responses to new contributors need to come within the hour.

**33. Mentioning Ada on GitHub** · RESOLVED: not supported

- Comments on GitHub don't reach Ada. Anyone can write a public comment, and owner
  rights come only from the Telegram and Discord ids (rule 5).

**34. Discord commands in DMs** · RESOLVED

- The slash commands are registered globally and work in the server and in DMs with
  the bot, so conversations with Ada can stay private. Who may do what is unchanged
  (decision 15).
- Plain messages without a command would need a permanent connection to Discord,
  and Telegram already covers them.

**35. What a merge needs** · RESOLVED: checks in the gateway; low risk needs no second review

- The gateway checks every `github.merge` itself, when it is proposed and again just
  before it runs. The PR must be open and not a draft. Its head must be the commit the
  review check reviewed, and a review with nothing blocking must have been posted at
  that head. CI must be green, with no runs waiting for approval, and GitHub must report
  the PR mergeable. Nobody may have requested changes, and no threads may be unresolved.
  Failed checks are returned to the agent rather than queued; the card lists the checks.
- The gateway rates each PR low, medium or high risk from its files and size
  (`config/review.yaml`). A medium- or high-risk PR also needs an approving review
  from a maintainer other than its author. For a low-risk PR (only docs or tests, and
  small), the owner's approval of the card is enough.
- High-risk PRs get the review check on the deep tier and a high-risk card. This
  replaces the 200-line rule in decision 22.
- On repos whose branch protection requires an approving review, GitHub still refuses
  a low-risk merge without one; the card says so.
- Typed findings and their outcomes live in the gateway's database, so the share of
  findings maintainers act on is computed, not estimated.

**36. Who posts PR reviews** · RESOLVED: the gateway, as a second `auto` kind

- The review check submits its confirmed findings with `submit_review`, and the gateway
  posts them as one review that only comments: it never approves or requests changes.
  This is the `github.review` action kind, which runs without a card, like
  `github.approve_ci`.
- Before posting, the gateway checks each finding against the PR's files and the limits
  in `config/review.yaml`. It refuses text that @mentions anyone but the PR's author,
  which could ping people or trigger a bot, and text about how the review was made.
- Agents no longer post reviews through their own GitHub app.

**37. Jev for PR triage** · RESOLVED: not now; watch costs first

- A semantic classifier (TypeSafe's Jev) could answer the triage questions (a PR's
  kind, risk and spam) that run on Claude's fast tier today. It has an HTTP API and a
  TypeScript SDK, so the gateway could call it.
- One blind run on 50 historical concerto PRs is the only evidence, and it is thin. Jev
  matched 11 of 15 labels that a Claude model drew from maintainers' comments. Its
  confidence did not track accuracy, and nobody compared its cost with Claude's.
- Neither Jev nor Claude resists prompt injection, so the same rule applies to both:
  a model's output may raise risk or route a PR to the owner, but never loosen a
  check the gateway computes (decision 35).
- Triage stays on Claude's fast tier. The owner is watching its cost over the next few
  weeks; if that is high, a head-to-head trial of Jev and the fast tier on about 100
  labelled PRs, comparing accuracy and cost per PR, is the next step.
