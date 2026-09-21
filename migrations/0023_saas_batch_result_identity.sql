-- OneGl v0.8 — batch question identity for SaaS callers.
--
-- A SaaS batch may submit the same question text many times (one row per question ×
-- repetition observation). Each row carries the caller's own stable `external_id`, so
-- OneGl must be able to keep two identical texts apart and must be able to trace every
-- public result back to the entry that produced it.
--
-- Three additive changes:
--   1. prompts may now hold one row per (text, external_id). The old global per-text
--      uniqueness is narrowed to rows without an external_id, so every existing writer
--      (project:init pool import, keyword UI, persistRun) keeps its current behaviour.
--   2. service_task_questions records the exact ordered entry list a Task was created
--      from, including repetition coordinates.
--   3. service_task_results carries external_id / repetition_index / repetition_count so
--      the public result projections can echo the caller's mapping keys.

-- ---------------------------------------------------------------- 1. prompt identity
-- prompts_project_hash_key is a table constraint, so it cannot carry an index predicate.
-- Replace it with two partial unique indexes:
--   * (project_id, prompt_md5)      WHERE external_id IS NULL     -> today's semantics
--   * (project_id, prompt_md5, external_id) WHERE external_id IS NOT NULL
ALTER TABLE prompts DROP CONSTRAINT IF EXISTS prompts_project_hash_key;

CREATE UNIQUE INDEX IF NOT EXISTS prompts_project_prompt_key
  ON prompts (project_id, prompt_md5)
  WHERE external_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS prompts_project_prompt_external_key
  ON prompts (project_id, prompt_md5, external_id)
  WHERE external_id IS NOT NULL;

-- ---------------------------------------------------------------- 2. task question entries
CREATE TABLE IF NOT EXISTS service_task_questions (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id         bigint      NOT NULL REFERENCES service_tenants (id) ON DELETE CASCADE,
  task_id           bigint      NOT NULL REFERENCES service_tasks (id) ON DELETE CASCADE,
  ordinal           integer     NOT NULL,
  external_id       text,
  question          text        NOT NULL,
  category          text,
  repetition_index  integer,
  repetition_count  integer,
  prompt_id         bigint      REFERENCES prompts (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_task_questions_ordinal_key UNIQUE (task_id, ordinal),
  CONSTRAINT service_task_questions_repetition_index_check CHECK (repetition_index IS NULL OR repetition_index >= 1),
  CONSTRAINT service_task_questions_repetition_count_check CHECK (repetition_count IS NULL OR repetition_count >= 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS service_task_questions_external_key
  ON service_task_questions (task_id, external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS service_task_questions_task_idx ON service_task_questions (task_id, ordinal);
CREATE INDEX IF NOT EXISTS service_task_questions_tenant_idx ON service_task_questions (tenant_id, task_id);

-- ---------------------------------------------------------------- 3. result identity
ALTER TABLE service_task_results
  ADD COLUMN IF NOT EXISTS external_id       text,
  ADD COLUMN IF NOT EXISTS repetition_index  integer,
  ADD COLUMN IF NOT EXISTS repetition_count  integer;

ALTER TABLE service_task_results
  DROP CONSTRAINT IF EXISTS service_task_results_repetition_index_check;
ALTER TABLE service_task_results
  ADD CONSTRAINT service_task_results_repetition_index_check CHECK (repetition_index IS NULL OR repetition_index >= 1);
ALTER TABLE service_task_results
  DROP CONSTRAINT IF EXISTS service_task_results_repetition_count_check;
ALTER TABLE service_task_results
  ADD CONSTRAINT service_task_results_repetition_count_check CHECK (repetition_count IS NULL OR repetition_count >= 1);

-- One caller entry maps to exactly one result per execution. The index is the hard
-- guarantee; normalizeTaskInput rejects a duplicated external_id before we get here.
CREATE UNIQUE INDEX IF NOT EXISTS service_task_results_execution_external_key
  ON service_task_results (execution_id, external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS service_task_results_external_idx
  ON service_task_results (execution_id, external_id);

DO $$
DECLARE target_role text := 'onegl';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON service_task_questions TO %I', target_role);
    EXECUTE format('GRANT SELECT, UPDATE ON service_task_results TO %I', target_role);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', target_role);
  END IF;
END
$$;
