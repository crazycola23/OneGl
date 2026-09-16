-- OneGl — GEO intelligence foundations
--
-- Adds provider identity metadata to runs and first-class competitor configuration.
-- Existing rows remain valid: historical Doubao web runs are backfilled as scraped/doubao.

ALTER TABLE runs
  ADD COLUMN provider_access text NOT NULL DEFAULT 'scraped',
  ADD COLUMN model text,
  ADD COLUMN model_version text;

UPDATE runs
   SET model = COALESCE(model, provider)
 WHERE model IS NULL;

ALTER TABLE runs
  ALTER COLUMN model SET DEFAULT 'doubao';

ALTER TABLE runs ADD CONSTRAINT runs_provider_access_check
  CHECK (provider_access IN ('scraped', 'api'));

CREATE INDEX runs_provider_model_idx
  ON runs (provider, model, provider_access, created_at DESC);

CREATE TABLE project_competitors (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id       bigint      NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name             text        NOT NULL,
  aliases          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  domains          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  exclude_patterns jsonb       NOT NULL DEFAULT '[]'::jsonb,
  enabled          boolean     NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_competitors_project_name_key UNIQUE (project_id, name),
  CONSTRAINT project_competitors_name_check CHECK (char_length(trim(name)) BETWEEN 1 AND 200)
);

CREATE INDEX project_competitors_project_idx
  ON project_competitors (project_id, enabled, id);
