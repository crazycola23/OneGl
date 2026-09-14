-- OneGl v0.3 — observable page evidence for retrieved candidates
--
-- This table stores a batch-scoped snapshot of derived page features. It deliberately does not
-- store raw third-party HTML. These fields describe what OneGl's own fetcher could observe at
-- capture time; they are not evidence that Doubao fetched, parsed, or ranked the page the same way.

CREATE TABLE article_page_observations (
  id                            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id                      bigint      NOT NULL REFERENCES sampling_batches (id) ON DELETE CASCADE,
  article_id                    bigint      NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  requested_url                 text        NOT NULL,
  final_url                     text,
  fetch_state                   text        NOT NULL,
  http_status                   integer,
  content_type                  text,
  response_bytes                integer,
  captured_at                   timestamptz NOT NULL DEFAULT now(),
  error_code                    text,
  error_message                 text,
  content_hash                  text,
  title_text                    text,
  meta_description              text,
  canonical_href                text,
  text_length                   integer,
  numeric_token_count           integer,
  numeric_tokens_per_1000_chars double precision,
  h1_count                      integer,
  h2_count                      integer,
  h3_count                      integer,
  table_count                   integer,
  list_count                    integer,
  faq_heading_count             integer,
  question_heading_count        integer,
  external_link_count           integer,
  jsonld_count                  integer,
  schema_types                  jsonb NOT NULL DEFAULT '[]'::jsonb,
  has_article_schema            boolean,
  has_faq_schema                boolean,
  author_present                boolean,
  published_at_raw              text,
  modified_at_raw               text,
  robots_noindex                boolean,
  robots_nofollow               boolean,
  diagnostics                   jsonb NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT article_page_observations_batch_article_key UNIQUE (batch_id, article_id),
  CONSTRAINT article_page_observations_fetch_state_check CHECK (
    fetch_state IN ('success', 'blocked', 'non_html', 'too_large', 'http_error', 'redirect_limit', 'error')
  ),
  CONSTRAINT article_page_observations_counts_check CHECK (
    (response_bytes IS NULL OR response_bytes >= 0)
    AND (text_length IS NULL OR text_length >= 0)
    AND (numeric_token_count IS NULL OR numeric_token_count >= 0)
    AND (numeric_tokens_per_1000_chars IS NULL OR numeric_tokens_per_1000_chars >= 0)
    AND (h1_count IS NULL OR h1_count >= 0)
    AND (h2_count IS NULL OR h2_count >= 0)
    AND (h3_count IS NULL OR h3_count >= 0)
    AND (table_count IS NULL OR table_count >= 0)
    AND (list_count IS NULL OR list_count >= 0)
    AND (faq_heading_count IS NULL OR faq_heading_count >= 0)
    AND (question_heading_count IS NULL OR question_heading_count >= 0)
    AND (external_link_count IS NULL OR external_link_count >= 0)
    AND (jsonld_count IS NULL OR jsonld_count >= 0)
  )
);

CREATE INDEX article_page_observations_batch_idx ON article_page_observations (batch_id);
CREATE INDEX article_page_observations_article_idx ON article_page_observations (article_id);
CREATE INDEX article_page_observations_state_idx ON article_page_observations (fetch_state);
