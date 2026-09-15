-- OneGl v0.4 — automatic cited-source intelligence job state
--
-- The AI-answer sampling batch remains the primary experiment record. Cited-page
-- intelligence is a separate best-effort background stage: failures here must never
-- rewrite the sampling batch outcome.

ALTER TABLE sampling_batches
  ADD COLUMN IF NOT EXISTS source_intelligence_generation integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS source_intelligence_status text NOT NULL DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS source_intelligence_queued_at timestamptz,
  ADD COLUMN IF NOT EXISTS source_intelligence_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS source_intelligence_finished_at timestamptz,
  ADD COLUMN IF NOT EXISTS source_intelligence_error text;

ALTER TABLE sampling_batches
  DROP CONSTRAINT IF EXISTS sampling_batches_source_intelligence_status_check;

ALTER TABLE sampling_batches
  ADD CONSTRAINT sampling_batches_source_intelligence_status_check CHECK (
    source_intelligence_status IN ('idle', 'queued', 'running', 'completed', 'partial', 'failed')
  );

ALTER TABLE sampling_batches
  ADD CONSTRAINT sampling_batches_source_intelligence_generation_check CHECK (
    source_intelligence_generation >= 0
  );

CREATE INDEX IF NOT EXISTS sampling_batches_source_intelligence_status_idx
  ON sampling_batches (source_intelligence_status, finished_at DESC);
