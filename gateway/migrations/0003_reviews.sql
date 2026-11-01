-- Mira's posted reviews and their findings, and what came of them (decisions 35 and 36).
-- Replaces the review ledger she kept in her memory store.

CREATE TABLE reviews (
  id                TEXT PRIMARY KEY,           -- R-12
  seq               INTEGER NOT NULL,
  target            TEXT NOT NULL,              -- owner/repo#123, lower case
  sha               TEXT NOT NULL,              -- the full head commit reviewed
  risk              TEXT NOT NULL,              -- low | medium | high, computed by the gateway
  verdict           TEXT NOT NULL,              -- approve | comment | request_changes
  decision_id       TEXT,                       -- the github.review decision that posted it
  url               TEXT,
  merge_decision_id TEXT,                       -- the github.merge proposal for this head, if any
  outcome           TEXT,                       -- merged | closed | reverted | follow_up
  outcome_note      TEXT,
  outcome_at        TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX reviews_target ON reviews(target, sha);

CREATE TABLE review_findings (
  id           TEXT PRIMARY KEY,                -- F-31
  seq          INTEGER NOT NULL,
  review_id    TEXT NOT NULL,
  target       TEXT NOT NULL,
  path         TEXT,
  line         INTEGER,
  severity     TEXT NOT NULL,                   -- blocking | should-fix | nit
  area         TEXT NOT NULL,                   -- an area from config/review.yaml
  summary      TEXT NOT NULL,
  outcome      TEXT,                            -- acted | dismissed
  outcome_note TEXT,
  outcome_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX review_findings_open ON review_findings(outcome, target);

INSERT INTO counters (name, value) VALUES ('review', 0), ('finding', 0);
