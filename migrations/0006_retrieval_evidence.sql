-- OneGl — Network retrieval evidence persistence
--
-- Keep search/retrieval evidence separate from DOM-visible citations. A network candidate is
-- not a citation. The only automatic relation recorded here is canonical URL exact equality
-- against a DOM-visible citation from the same run.

ALTER TABLE runs
  ADD COLUMN network_evidence_state text,
  ADD COLUMN network_evidence_diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN search_query_count integer NOT NULL DEFAULT 0,
  ADD COLUMN retrieved_source_count integer NOT NULL DEFAULT 0;

ALTER TABLE runs ADD CONSTRAINT runs_network_evidence_state_check
  CHECK (network_evidence_state IS NULL OR network_evidence_state IN ('disabled', 'none', 'partial', 'found'));
ALTER TABLE runs ADD CONSTRAINT runs_search_query_count_check CHECK (search_query_count >= 0);
ALTER TABLE runs ADD CONSTRAINT runs_retrieved_source_count_check CHECK (retrieved_source_count >= 0);

CREATE TABLE run_search_queries (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id         bigint      NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  query_position integer     NOT NULL,
  query_text     text        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT run_search_queries_position_check CHECK (query_position > 0),
  CONSTRAINT run_search_queries_text_check CHECK (char_length(query_text) BETWEEN 1 AND 1000),
  CONSTRAINT run_search_queries_run_position_key UNIQUE (run_id, query_position)
);

CREATE INDEX run_search_queries_run_idx ON run_search_queries (run_id);

CREATE TABLE retrieved_sources (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id              bigint      NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  article_id          bigint      NOT NULL REFERENCES articles (id) ON DELETE RESTRICT,
  source_position     integer     NOT NULL,
  source_name         text,
  summary             text,
  captured_from       text        NOT NULL DEFAULT 'NETWORK',
  visible_to_user     boolean     NOT NULL DEFAULT false,
  visible_citation_id bigint      REFERENCES citations (id) ON DELETE SET NULL,
  match_method        text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT retrieved_sources_position_check CHECK (source_position > 0),
  CONSTRAINT retrieved_sources_capture_check CHECK (captured_from = 'NETWORK'),
  CONSTRAINT retrieved_sources_visibility_check CHECK (visible_to_user = false),
  CONSTRAINT retrieved_sources_match_check CHECK (
    (visible_citation_id IS NULL AND match_method IS NULL)
    OR
    (visible_citation_id IS NOT NULL AND match_method = 'canonical_url_exact')
  ),
  CONSTRAINT retrieved_sources_run_article_key UNIQUE (run_id, article_id)
);

CREATE INDEX retrieved_sources_run_idx ON retrieved_sources (run_id);
CREATE INDEX retrieved_sources_article_idx ON retrieved_sources (article_id);
CREATE INDEX retrieved_sources_visible_citation_idx ON retrieved_sources (visible_citation_id)
  WHERE visible_citation_id IS NOT NULL;
