import { exactCitationMatch, prepareRetrievedSources, prepareSearchQueries } from "./retrieval.js";

const ARTICLE_UPSERT = `
  INSERT INTO articles (canonical_url, original_url, title, domain, normalized_domain)
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (canonical_url) DO UPDATE
    SET last_seen_at = now(),
        updated_at = now(),
        title = COALESCE(EXCLUDED.title, articles.title),
        original_url = EXCLUDED.original_url
  RETURNING id, (xmax = 0) AS inserted
`;

const QUERY_INSERT = `
  INSERT INTO run_search_queries (run_id, query_position, query_text)
  VALUES ($1, $2, $3)
`;

const RETRIEVED_INSERT = `
  INSERT INTO retrieved_sources (
    run_id, article_id, source_position, source_name, summary,
    captured_from, visible_to_user, visible_citation_id, match_method
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
`;

export async function persistRetrievalEvidence({ client, runId, run }) {
  const queryRows = prepareSearchQueries(run?.searchQueries);
  const { rows: sourceRows, skipped } = prepareRetrievedSources(run?.retrievedSources);

  await client.query("DELETE FROM run_search_queries WHERE run_id = $1", [runId]);
  await client.query("DELETE FROM retrieved_sources WHERE run_id = $1", [runId]);

  for (const row of queryRows) {
    await client.query(QUERY_INSERT, [runId, row.queryPosition, row.queryText]);
  }

  const visibleRows = (
    await client.query(
      `SELECT a.canonical_url, c.id
         FROM citations c
         JOIN articles a ON a.id = c.article_id
        WHERE c.run_id = $1
          AND c.source_type = 'visible'
          AND c.visible_to_user IS TRUE`,
      [runId],
    )
  ).rows;
  const visibleByCanonicalUrl = new Map(
    visibleRows.map((row) => [row.canonical_url, { id: row.id }]),
  );

  let articlesCreated = 0;
  let exactMatches = 0;
  for (const row of sourceRows) {
    const articleResult = await client.query(ARTICLE_UPSERT, [
      row.canonicalUrl,
      row.originalUrl,
      row.title,
      row.domain,
      row.normalizedDomain,
    ]);
    const articleId = articleResult.rows[0].id;
    if (articleResult.rows[0].inserted) articlesCreated += 1;

    const match = exactCitationMatch(row.canonicalUrl, visibleByCanonicalUrl);
    if (match.visibleCitationId) exactMatches += 1;
    await client.query(RETRIEVED_INSERT, [
      runId,
      articleId,
      row.sourcePosition,
      row.sourceName,
      row.summary,
      row.capturedFrom,
      row.visibleToUser,
      match.visibleCitationId,
      match.matchMethod,
    ]);
  }

  await client.query(
    `UPDATE runs
        SET network_evidence_state = $2,
            network_evidence_diagnostics = $3::jsonb,
            search_query_count = $4,
            retrieved_source_count = $5
      WHERE id = $1`,
    [
      runId,
      run?.networkEvidenceState ?? null,
      JSON.stringify(Array.isArray(run?.networkEvidenceDiagnostics) ? run.networkEvidenceDiagnostics : []),
      queryRows.length,
      sourceRows.length,
    ],
  );

  return {
    searchQueriesWritten: queryRows.length,
    retrievedSourcesWritten: sourceRows.length,
    retrievedSourcesSkipped: skipped.length,
    retrievedArticlesCreated: articlesCreated,
    exactCitationMatches: exactMatches,
    exactCitationConversionRate: sourceRows.length ? exactMatches / sourceRows.length : null,
  };
}
