-- Fixing failed CI on tracked PRs (decision 63).

-- github_wakes.trigger gains 'ci_failed' (Mira diagnoses) and 'ci_fix' (Felix fixes),
-- and tasks.kind gains 'ci_fix', with review_target and review_sha naming the PR and
-- head. Neither column has a constraint, so neither needs a change.

-- Mira's diagnosis for a ci_fix wake, which goes into Felix's brief as data. Written
-- by an agent, never by GitHub.
ALTER TABLE github_wakes ADD COLUMN note TEXT;
