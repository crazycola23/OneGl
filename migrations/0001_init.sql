-- OneGl v0.2 — Persistent Citation Intelligence
-- Initial schema: Project -> Prompt -> Run -> Citation -> Article
--
-- Design notes
--   * Run keeps the UI-declared expected citation count next to the captured count so
--     the Phase 0 verification signal (expected 18 / captured 18) survives in the DB.
--   * Article is deduplicated on canonical_url: one article referenced 100 times is
--     1 article row and 100 citation rows.
--   * relation_status may legitimately be 'unresolved'. The Answer <-> Citation link is
--     never fabricated to make the data look complete.
--   * local_run_id mirrors the run_<timestamp>_<uuid> id the collector already uses, so a
--     row can always be traced back to its .onegl/runs/<id> debug artifacts.
--
-- Each migration file is executed inside a single transaction by the runner
-- (src/db/migrate.js), so this file must not manage its own BEGIN/COMMIT.

-- ---------------------------------------------------------------- projects
CREATE TABLE projects (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text        NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT projects_name_key UNIQUE (name)
);

-- ---------------------------------------------------------------- prompts
CREATE TABLE prompts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id    bigint      NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  prompt        text        NOT NULL,
  -- Prompts are long free text, so the dedup key is a hash rather than the raw text
  -- (a plain btree unique index would break past ~2700 bytes). md5() is used rather
  -- than sha256(convert_to(...)) because only md5() is IMMUTABLE in PostgreSQL and a
  -- generated column rejects non-immutable expressions.
  prompt_md5    text        GENERATED ALWAYS AS (md5(prompt)) STORED,
  external_id   text,
  enabled       boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prompts_project_hash_key UNIQUE (project_id, prompt_md5)
);

CREATE INDEX prompts_project_id_idx ON prompts (project_id);

-- ---------------------------------------------------------------- runs
-- One row per executed Doubao prompt.
CREATE TABLE runs (
  id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  prompt_id                bigint      NOT NULL REFERENCES prompts (id) ON DELETE CASCADE,
  provider                 text        NOT NULL DEFAULT 'doubao',
  status                   text        NOT NULL,
  started_at               timestamptz NOT NULL,
  finished_at              timestamptz,
  answer                   text,
  expected_citation_count  integer,
  captured_citation_count  integer     NOT NULL DEFAULT 0,
  citation_state           text,
  citation_diagnostics     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  submission_method        text,
  conversation_reset       boolean,
  current_url              text,
  error_code               text,
  error_message            text,
  error_details            jsonb,
  -- collector-side run id, keeps the row traceable to its debug artifacts
  local_run_id             text        NOT NULL,
  artifact_path            text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runs_status_check CHECK (status IN ('pending', 'running', 'success', 'partial', 'failed')),
  CONSTRAINT runs_local_run_id_key UNIQUE (local_run_id),
  CONSTRAINT runs_citation_counts_check CHECK (
    captured_citation_count >= 0
    AND (expected_citation_count IS NULL OR expected_citation_count >= 0)
  )
);

CREATE INDEX runs_prompt_id_idx ON runs (prompt_id);
CREATE INDEX runs_created_at_idx ON runs (created_at DESC);
CREATE INDEX runs_status_idx ON runs (status);

-- ---------------------------------------------------------------- articles
-- Deduplicated by canonical_url: repeated citations reuse the same row.
CREATE TABLE articles (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  canonical_url     text        NOT NULL,
  original_url      text        NOT NULL,
  title             text,
  -- hostname exactly as observed, e.g. m.toutiao.com
  domain            text        NOT NULL,
  -- registrable domain used for aggregation, e.g. toutiao.com
  normalized_domain text        NOT NULL,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT articles_canonical_url_key UNIQUE (canonical_url),
  -- Keep well clear of the btree index limit so over-long URLs fail loudly here
  -- instead of with an opaque index error.
  CONSTRAINT articles_canonical_url_len_check CHECK (char_length(canonical_url) <= 2048),
  CONSTRAINT articles_original_url_len_check CHECK (char_length(original_url) <= 4096)
);

CREATE INDEX articles_domain_idx ON articles (domain);
CREATE INDEX articles_normalized_domain_idx ON articles (normalized_domain);

-- ---------------------------------------------------------------- citations
-- "This run cited this article."
CREATE TABLE citations (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id          bigint      NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  article_id      bigint      NOT NULL REFERENCES articles (id) ON DELETE RESTRICT,
  source_position integer     NOT NULL,
  citation_marker text,
  answer_text     text,
  relation_status text        NOT NULL,
  captured_from   text        NOT NULL DEFAULT 'DOM',
  visible_to_user boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT citations_relation_status_check CHECK (relation_status IN ('matched', 'unresolved')),
  -- Makes re-persisting the same run idempotent.
  CONSTRAINT citations_run_position_key UNIQUE (run_id, source_position),
  CONSTRAINT citations_source_position_check CHECK (source_position > 0)
);

CREATE INDEX citations_run_id_idx ON citations (run_id);
CREATE INDEX citations_article_id_idx ON citations (article_id);
CREATE INDEX citations_created_at_idx ON citations (created_at DESC);
