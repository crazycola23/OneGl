-- OneGl v0.3 — Keyword sampling, multi-account visibility monitoring
--
-- Adds the objects a sampling experiment needs on top of the v0.2 capture tables:
--   Keyword Pool  -> prompts.category / pool_version
--   Accounts      -> accounts            (anonymous identifiers only)
--   Sampling      -> sampling_batches, sampling_batch_prompts
--   Brand         -> projects.target_brand + alias rules, runs.*_mention_* columns
--   Tracked articles -> tracked_articles, citations.tracked_article_id
--
-- Everything is additive; no v0.2 column is dropped or renamed.

-- ---------------------------------------------------------------- project brand
ALTER TABLE projects ADD COLUMN target_brand           text;
ALTER TABLE projects ADD COLUMN brand_aliases          jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE projects ADD COLUMN brand_product_aliases  jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE projects ADD COLUMN brand_exclude_patterns jsonb NOT NULL DEFAULT '[]'::jsonb;

-- ---------------------------------------------------------------- keyword pool
ALTER TABLE prompts ADD COLUMN category     text;
ALTER TABLE prompts ADD COLUMN pool_version text;
ALTER TABLE prompts ADD COLUMN source       text NOT NULL DEFAULT 'manual';
-- Which 'sampling'/'pool'/'batch-file' a prompt came in through. Not constrained by a
-- CHECK so a new ingestion path does not require a migration.

CREATE INDEX prompts_category_idx ON prompts (category);

-- ---------------------------------------------------------------- accounts
-- Only an anonymous identifier is stored here. Cookies and storage state live in
-- .onegl/auth/accounts/<account_key>.storage.json and never reach the database.
CREATE TABLE accounts (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_key            text        NOT NULL,
  provider               text        NOT NULL DEFAULT 'doubao',
  label                  text,
  enabled                boolean     NOT NULL DEFAULT true,
  last_health_status     text,
  last_health_checked_at timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounts_provider_key_key UNIQUE (provider, account_key)
);

-- ---------------------------------------------------------------- sampling batch
CREATE TABLE sampling_batches (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id       bigint      NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name             text        NOT NULL,
  provider         text        NOT NULL DEFAULT 'doubao',
  -- reproducible selection record
  pool_version     text,
  pool_size        integer     NOT NULL,
  sample_size      integer     NOT NULL,
  sampling_method  text        NOT NULL,
  sampling_seed    text        NOT NULL,
  account_keys     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  repeats          integer     NOT NULL DEFAULT 1,
  started_at       timestamptz,
  finished_at      timestamptz,
  status           text        NOT NULL DEFAULT 'pending',
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sampling_batches_method_check CHECK (sampling_method IN ('random', 'stratified')),
  CONSTRAINT sampling_batches_status_check CHECK (status IN ('pending', 'running', 'completed', 'failed', 'aborted')),
  CONSTRAINT sampling_batches_size_check CHECK (sample_size > 0 AND pool_size > 0),
  CONSTRAINT sampling_batches_repeats_check CHECK (repeats > 0)
);

CREATE INDEX sampling_batches_project_idx ON sampling_batches (project_id);
CREATE INDEX sampling_batches_created_idx ON sampling_batches (created_at DESC);

-- Exactly which prompts were drawn, in which category, handed to which account.
-- Together with sampling_seed and pool_version this makes a batch reproducible.
CREATE TABLE sampling_batch_prompts (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id        bigint      NOT NULL REFERENCES sampling_batches (id) ON DELETE CASCADE,
  prompt_id       bigint      NOT NULL REFERENCES prompts (id) ON DELETE RESTRICT,
  category        text,
  selection_index integer     NOT NULL,
  account_key     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sampling_batch_prompts_index_key UNIQUE (batch_id, selection_index),
  CONSTRAINT sampling_batch_prompts_index_check CHECK (selection_index > 0)
);

CREATE INDEX sampling_batch_prompts_prompt_idx ON sampling_batch_prompts (prompt_id);
CREATE INDEX sampling_batch_prompts_account_idx ON sampling_batch_prompts (account_key);

-- ---------------------------------------------------------------- runs
ALTER TABLE runs ADD COLUMN sampling_batch_id           bigint REFERENCES sampling_batches (id) ON DELETE SET NULL;
ALTER TABLE runs ADD COLUMN account_key                 text;
-- True only when the run could confirm it started from a genuinely empty conversation.
-- Only confirmed runs belong in the headline mention-rate statistic.
ALTER TABLE runs ADD COLUMN conversation_reset_confirmed boolean;
ALTER TABLE runs ADD COLUMN brand_mentioned             boolean;
ALTER TABLE runs ADD COLUMN mention_count               integer;
ALTER TABLE runs ADD COLUMN first_mention_position      integer;
ALTER TABLE runs ADD COLUMN matched_terms               jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE runs ADD COLUMN brand_detection_version     text;

CREATE INDEX runs_sampling_batch_idx ON runs (sampling_batch_id);
CREATE INDEX runs_account_idx ON runs (account_key);
CREATE INDEX runs_brand_mentioned_idx ON runs (brand_mentioned);

-- ---------------------------------------------------------------- tracked articles
-- Articles the user wants to watch: does this article enter the set of sources
-- Doubao shows to end users? Matching is canonical-URL exact in this phase.
CREATE TABLE tracked_articles (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id        bigint      NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  canonical_url     text        NOT NULL,
  original_url      text        NOT NULL,
  title             text,
  domain            text,
  normalized_domain text,
  brand             text,
  enabled           boolean     NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tracked_articles_project_url_key UNIQUE (project_id, canonical_url),
  CONSTRAINT tracked_articles_url_len_check CHECK (char_length(canonical_url) <= 2048)
);

CREATE INDEX tracked_articles_project_idx ON tracked_articles (project_id);
CREATE INDEX tracked_articles_domain_idx ON tracked_articles (normalized_domain);

ALTER TABLE citations ADD COLUMN tracked_article_id bigint REFERENCES tracked_articles (id) ON DELETE SET NULL;

CREATE INDEX citations_tracked_article_idx ON citations (tracked_article_id);
