-- OneGl — crawler robustness for page evidence.
--
-- Adds the state that a polite, resumable crawler needs:
--   * conditional-request validators so an unchanged page costs one request and no
--     re-processing (and, more importantly, so "the page changed" becomes observable);
--   * a fetch_state value for a 200 response that carried no usable content, which must
--     never be counted as a successful page snapshot.
--
-- Additive only: existing rows keep their current state and get NULL validators.

ALTER TABLE article_page_observations
  ADD COLUMN IF NOT EXISTS etag text;

ALTER TABLE article_page_observations
  ADD COLUMN IF NOT EXISTS last_modified text;

ALTER TABLE article_page_observations
  DROP CONSTRAINT IF EXISTS article_page_observations_fetch_state_check;

ALTER TABLE article_page_observations
  ADD CONSTRAINT article_page_observations_fetch_state_check CHECK (
    fetch_state IN (
      'success',
      'blocked',
      'non_html',
      'too_large',
      'http_error',
      'redirect_limit',
      'error',
      'unusable'
    )
  );