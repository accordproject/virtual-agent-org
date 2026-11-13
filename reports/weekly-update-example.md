---
marp: true
title: Accord Project agent network — weekly update for the Tech WG, 11 November 2026
paginate: true
---

<!--
Example of Ada's weekly update (agents/ada.md, "Weekly update"). Copy the shape, not
the figures: ten slides in this order, each with one point. It is adapted from the
progress deck shown to the Tech WG on 11 November 2026, so it covers the first twelve
days rather than one week.
-->

# Accord Project agent network
## Weekly update for the Tech WG, 11 November 2026 · 31 Oct – 10 Nov

About 180 public actions · 93% approved as drafted · $75 spent

---

# Summary

- **Work done:** about 180 public actions: reviews, first responses, CI approvals, closures, recordings and announcements
- **Quality:** about 93% of the decisions the chair answered were approved as drafted; none needed edits
- **Bottleneck:** no community PR merged through the network yet; merges wait on a maintainer approval
- **KPIs:** none can yet be credited to the network
- **Cost:** about $75 at list price, heading for about $200–210 a month

---

# Key decisions

- **Added apap to the repos in scope:** Mira now triages and reviews accordproject/apap too
- **Approved the merge-path change:** reviewed, green PRs can be merged on the chair's approval, with a full merge card
- **Approved buttons in check-ins:** open decision cards are re-sent with Approve and Reject
- **Rejected 12 drafts;** the themes are on the feedback slide
- **Waiting longest:** merge proposals for clean, green PRs, some for 20+ days

---

# Changes to the network

Proposed from evidence → approved by the chair → built as a PR → measured 14 days after going live

| Status | Changes |
| --- | --- |
| Live (2) | Triage checks for an existing fix before replying; monitoring access for Vera |
| In review (2) | Merge path with detailed merge cards; buttons in check-ins |
| Stuck (1) | Held up by a platform limit |
| Dropped (1) | In favour of a better design |

- **Measured results:** none yet; the first is due around 19 Nov

---

# What the network did

| Count | What |
| --- | --- |
| ~60 | first responses and welcomes, many to first-time contributors who had waited weeks |
| ~35 | code reviews posted, 9 of them approvals |
| 21 | CI runs approved for first-time contributors' PRs |
| 10 | closures of stale, duplicate or out-of-policy PRs |
| 4 | Tech WG recordings published, with chapters |
| 2 / 4 | news-brief items raised at the WG |

*Counts are approximate and hand-tallied from the decision log.*

---

# Feedback and quality

- **93%** approved as drafted (about 166 approved, 12 rejected)
- **What the rejections had in common:**
  - didn't check for a related or already-merged fix first
  - drafted a reply to v1 playground work, now out of scope
  - tagged the wrong maintainers
- **Response:** a spec change for the first is live
- **Slips:** one inaccurate claim, corrected publicly; a few actions queued twice and caught before posting

---

# Impact on project KPIs

| KPI | Baseline | Target | Last week | This week |
| --- | --- | --- | --- | --- |
| Time to merge | mean 14.0 d, P90 42.1 d | 7 d / 21 d | — | mean 8.2 d, P90 21.6 d (n=28) |
| Time to first response | mean 7.7 d, P90 23.6 d | 2 bus. d / 5 d | — | not yet recomputed |
| Retention | 17.4% | 30% | — | too early |

- Most of the merge window is **before launch**, so the improvement can't be credited to the network

---

# Cost

- **$75.09** list price since 31 Oct; forecast **$202–210** for November against $200
- **Per executed action:** $0.27 triage, $0.31 WG support
- **Where it goes:** triage and review about 55%, coordination about 20%, building network changes about 19%
- **Savings identified:** about $20–35 a month (cheaper model for change-building, fewer triage runs)

---

# Observations

- **GitHub account suspended, then restored:** the network's service account was suspended for a terms violation over the weekend, then unsuspended; GitHub gave no explanation for either
- **Chair load:** about 200 decision cards in 12 days is a lot for one person
- **Merges are the bottleneck,** not drafting: reviewed PRs wait on maintainers
- **Audit gap:** some GitHub write calls aren't yet linked to a decision record (being investigated)

---

# Next week

- Ship the merge-path change
- Recompute first-response time and time to merge since launch
- Report the first measured effects of the network's changes
- **Ask of maintainers:** reviews and approvals on PRs the agents have flagged as ready

*Data: gateway decision log and audit, Vera's weekly scorecard, ap-stats baseline. Drafted by Ada, the network's chief of staff.*
