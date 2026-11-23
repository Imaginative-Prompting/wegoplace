-- 0031: the assistant's meter (docs/model.md §20), the host's money and nobody's words.
--
-- The assistant on a trip is paid for by the trip's host, out of their plan's monthly allowance, in
-- what the model really cost (millionths of a dollar of the provider's reported cost). One row per
-- call, kept as the ledger: the host whose month it counts in, the trip, who asked, the model, the
-- tokens and the cost. Never a word of what was asked or answered.
--
--   state 'out'      let out, not settled: it counts at its worst case (`worst`), reserved before it went
--   state 'dead'     out past busy_until with no settling (its Worker gone): still its worst case
--   state 'settled'  at what it cost (`cost`); a dead call that settles after all comes back to this
--
-- So the host's month is always SUM(settled ? cost : worst) over their calls in it, and a call is let
-- out by ONE conditional insert that holds that sum, plus this call's worst case, within the allowance:
-- two of a host's trips can run side by side and the budget still holds exactly. One ask at a time per
-- trip is the partial unique index below: a second 'out' call for a trip can't be written.
--
-- month: the calendar month (UTC, "YYYY-MM") the call started in; the allowance comes back with it.
-- user_id goes NULL when that person's account is deleted (the host's ledger keeps the money, not who).
CREATE TABLE ai_calls (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  trip_id TEXT NOT NULL,
  user_id TEXT,
  month TEXT NOT NULL,
  feature TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('out', 'dead', 'settled')),
  worst INTEGER NOT NULL CHECK (worst >= 0),
  cost INTEGER CHECK (cost IS NULL OR cost >= 0),
  started_at INTEGER NOT NULL,
  busy_until INTEGER NOT NULL,
  settled_at INTEGER,
  model TEXT NOT NULL DEFAULT '',
  prompt_tokens INTEGER,
  cached_tokens INTEGER,
  completion_tokens INTEGER,
  generation_id TEXT
);
CREATE INDEX ai_calls_host_month ON ai_calls (host_id, month);
CREATE INDEX ai_calls_trip ON ai_calls (trip_id, started_at);
CREATE UNIQUE INDEX ai_calls_one_out_per_trip ON ai_calls (trip_id) WHERE state = 'out';

-- The opaque tag the provider's abuse tools see instead of an account: random, made once per account,
-- never its id or name, gone with the account.
CREATE TABLE ai_tags (
  user_id TEXT PRIMARY KEY,
  tag TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
