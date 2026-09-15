-- OneGl v0.4 — cited-page content intelligence
--
-- Store only compact derived evidence for analysis. Raw third-party HTML/full article text
-- remains out of the database. The brand fields are batch-scoped because the target brand
-- and aliases come from the project attached to that batch.

ALTER TABLE article_page_observations
  ADD COLUMN IF NOT EXISTS content_excerpt text,
  ADD COLUMN IF NOT EXISTS paragraph_count integer,
  ADD COLUMN IF NOT EXISTS heading_outline jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS content_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS brand_mentioned boolean,
  ADD COLUMN IF NOT EXISTS brand_mention_count integer,
  ADD COLUMN IF NOT EXISTS brand_first_mention_position integer,
  ADD COLUMN IF NOT EXISTS brand_matched_terms jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS brand_contexts jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS brand_locations jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS brand_detection_version text,
  ADD COLUMN IF NOT EXISTS brand_terms_used jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE article_page_observations
  ADD CONSTRAINT article_page_observations_content_intelligence_counts_check CHECK (
    (paragraph_count IS NULL OR paragraph_count >= 0)
    AND (brand_mention_count IS NULL OR brand_mention_count >= 0)
    AND (brand_first_mention_position IS NULL OR brand_first_mention_position >= 0)
  );

CREATE INDEX IF NOT EXISTS article_page_observations_brand_idx
  ON article_page_observations (batch_id, brand_mentioned)
  WHERE fetch_state = 'success';
