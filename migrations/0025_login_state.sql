-- OneGl — observation surface
--
-- A run captured while signed out is a different observation condition from one captured on
-- an account, and the two must never be blended into one visibility or citation rate: the
-- number would stop describing any real user. This is orthogonal to provider_access, which
-- records how the data was obtained (scraped page vs official API) rather than whether a
-- logged-in identity stood behind it.
--
-- Every existing row was collected on a Doubao account, so the default is 'account'.
ALTER TABLE runs
  ADD COLUMN login_state text NOT NULL DEFAULT 'account';

ALTER TABLE runs ADD CONSTRAINT runs_login_state_check
  CHECK (login_state IN ('account', 'anonymous'));

-- Reads that compute rates are now partitioned by surface, so make that the leading access
-- path alongside the platform it belongs to.
CREATE INDEX runs_provider_login_state_idx
  ON runs (provider, login_state, created_at DESC);

-- Account rows carry the same distinction for reporting: an anonymous lane is a synthetic
-- queue/limit identity, not a person who signed in, and an operator must be able to see that
-- before concluding a binding is stuck without credentials.
ALTER TABLE accounts
  ADD COLUMN login_state text NOT NULL DEFAULT 'account';

ALTER TABLE accounts ADD CONSTRAINT accounts_login_state_check
  CHECK (login_state IN ('account', 'anonymous'));
