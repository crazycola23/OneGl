-- OneGl v0.3.1 — record the charset used to decode candidate-page evidence.
-- This keeps page-feature provenance auditable for Chinese sites that still serve GBK/GB18030.

ALTER TABLE article_page_observations
  ADD COLUMN IF NOT EXISTS content_charset text;
