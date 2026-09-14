-- Widen the retrieval -> citation match_method vocabulary.
--
-- 0006 shipped a single method (`canonical_url_exact`) so a retrieved candidate could
-- never be silently promoted to a visible citation. That guarantee is preserved: the
-- constraint still forces a non-null match_method whenever visible_citation_id is set.
-- What changes is that alias-based matches can now be stored *with their own label*
-- instead of being forced to either lie ("exact") or be dropped.
--
-- Read the tiers as confidence levels, not equivalents:
--   canonical_url_exact   same normalised URL                     (authoritative)
--   canonical_url_redirect network candidate's redirect target
--   canonical_url_html    page-declared <link rel="canonical">
--   site_rule_alias       www / m. / amp / trailing-slash folding
--   content_hash_alias    identical body hash

ALTER TABLE retrieved_sources
  DROP CONSTRAINT retrieved_sources_match_check;

ALTER TABLE retrieved_sources
  ADD CONSTRAINT retrieved_sources_match_check CHECK (
    (visible_citation_id IS NULL AND match_method IS NULL)
    OR
    (
      visible_citation_id IS NOT NULL
      AND match_method IN (
        'canonical_url_exact',
        'canonical_url_redirect',
        'canonical_url_html',
        'site_rule_alias',
        'content_hash_alias'
      )
    )
  );