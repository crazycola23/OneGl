import { canonicalizeUrl, domainFromUrl } from "../url.js";
import { normalizeDomain } from "./domain.js";

export class DatabasePersistError extends Error {
  constructor(message, options = undefined) {
    super(message, options);
    this.name = "DatabasePersistError";
  }
}

const PROJECT_UPSERT = `
  INSERT INTO projects (name, description)
  VALUES ($1, $2)
  ON CONFLICT (name) DO UPDATE
    SET updated_at = now(),
        description = COALESCE(projects.description, EXCLUDED.description)
  RETURNING id
`;

const PROMPT_UPSERT = `
  INSERT INTO prompts (project_id, prompt, external_id, enabled)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT (project_id, prompt_md5) DO UPDATE
    SET updated_at = now(),
        external_id = COALESCE(EXCLUDED.external_id, prompts.external_id),
        enabled = EXCLUDED.enabled
  RETURNING id
`;

const RUN_UPSERT = `
  INSERT INTO runs (
    prompt_id, provider, status, started_at, finished_at, answer,
    expected_citation_count, captured_citation_count, citation_state, citation_diagnostics,
    submission_method, conversation_reset, current_url, error_code, error_message, error_details,
    local_run_id, artifact_path
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb,
          $11, $12, $13, $14, $15, $16::jsonb, $17, $18)
  ON CONFLICT (local_run_id) DO UPDATE
    SET prompt_id = EXCLUDED.prompt_id,
        provider = EXCLUDED.provider,
        status = EXCLUDED.status,
        started_at = EXCLUDED.started_at,
        finished_at = EXCLUDED.finished_at,
        answer = EXCLUDED.answer,
        expected_citation_count = EXCLUDED.expected_citation_count,
        captured_citation_count = EXCLUDED.captured_citation_count,
        citation_state = EXCLUDED.citation_state,
        citation_diagnostics = EXCLUDED.citation_diagnostics,
        submission_method = EXCLUDED.submission_method,
        conversation_reset = EXCLUDED.conversation_reset,
        current_url = EXCLUDED.current_url,
        error_code = EXCLUDED.error_code,
        error_message = EXCLUDED.error_message,
        error_details = EXCLUDED.error_details,
        artifact_path = EXCLUDED.artifact_path
  RETURNING id
`;

// (xmax = 0) is true only for a freshly inserted tuple, which lets the caller report
// how many articles were actually new versus reused by deduplication.
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

const CITATION_UPSERT = `
  INSERT INTO citations (
    run_id, article_id, source_position, citation_marker, answer_text,
    relation_status, captured_from, visible_to_user
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  ON CONFLICT (run_id, source_position) DO UPDATE
    SET article_id = EXCLUDED.article_id,
        citation_marker = EXCLUDED.citation_marker,
        answer_text = EXCLUDED.answer_text,
        relation_status = EXCLUDED.relation_status,
        captured_from = EXCLUDED.captured_from,
        visible_to_user = EXCLUDED.visible_to_user
`;

const ALLOWED_RELATION_STATUS = new Set(["matched", "unresolved"]);

function prepareCitations(citations) {
  const unsupported = [
    ...new Set(
      citations
        .map((citation) => citation?.relationStatus)
        .filter((value) => value != null && !ALLOWED_RELATION_STATUS.has(value)),
    ),
  ];
  if (unsupported.length) {
    throw new DatabasePersistError(
      `Unsupported relationStatus value(s): ${unsupported.join(", ")}. ` +
        "The schema only accepts 'matched' or 'unresolved'.",
    );
  }

  const rows = [];
  const skipped = [];
  citations.forEach((citation, index) => {
    const originalUrl = citation?.url ?? null;
    const canonicalUrl = citation?.canonicalUrl ?? canonicalizeUrl(originalUrl);
    if (!canonicalUrl || !originalUrl) {
      skipped.push({ index, reason: "missing-url" });
      return;
    }

    const domain = citation.domain ?? domainFromUrl(canonicalUrl);
    const requested = citation.sourcePosition;
    const sourcePosition =
      Number.isInteger(requested) && requested > 0 ? requested : index + 1;

    rows.push({
      canonicalUrl,
      originalUrl,
      title: citation.title ?? null,
      domain: domain ?? "unknown",
      normalizedDomain: normalizeDomain(domain) ?? "unknown",
      sourcePosition,
      citationMarker: citation.citationMarker ?? null,
      answerText: citation.answerText ?? null,
      relationStatus: citation.relationStatus === "matched" ? "matched" : "unresolved",
      capturedFrom: citation.capturedFrom ?? "DOM",
      visibleToUser: citation.visibleToUser !== false,
    });
  });

  return { rows, skipped };
}

/**
 * Writes one collector run into PostgreSQL as a single all-or-nothing transaction.
 *
 * Ordering follows the pipeline: upsert Project and Prompt, upsert the Run, then
 * upsert each Article and attach a Citation. Any failure rolls the whole thing back,
 * so a Run can never end up with half of its Citations written.
 */
export async function persistRun({ pool, run, project = null, prompt = null, artifactPath = null }) {
  if (!pool) throw new DatabasePersistError("persistRun requires a connection pool");

  const citations = Array.isArray(run?.citations) ? run.citations : [];
  const { rows: citationRows, skipped } = prepareCitations(citations);
  const projectName = project || run?.project || "default";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const projectResult = await client.query(PROJECT_UPSERT, [projectName, null]);
    const projectId = projectResult.rows[0].id;

    const promptResult = await client.query(PROMPT_UPSERT, [
      projectId,
      run?.prompt ?? "",
      prompt?.externalId ?? null,
      prompt?.enabled !== false,
    ]);
    const promptId = promptResult.rows[0].id;

    const runResult = await client.query(RUN_UPSERT, [
      promptId,
      run?.provider ?? "doubao",
      run?.status ?? "running",
      run?.startedAt ?? new Date().toISOString(),
      run?.completedAt ?? null,
      run?.answer ?? null,
      run?.expectedCitationCount ?? null,
      citations.length,
      run?.citationState ?? null,
      JSON.stringify(Array.isArray(run?.citationDiagnostics) ? run.citationDiagnostics : []),
      run?.submissionMethod ?? null,
      run?.conversationReset ?? null,
      run?.currentUrl ?? null,
      run?.errorCode ?? null,
      run?.errorMessage ?? null,
      run?.errorDetails == null ? null : JSON.stringify(run.errorDetails),
      run?.id ?? null,
      artifactPath,
    ]);
    const runId = runResult.rows[0].id;

    // Re-persisting the same run must converge, not accumulate.
    await client.query("DELETE FROM citations WHERE run_id = $1", [runId]);

    let articlesCreated = 0;
    const articleIds = new Set();

    for (const row of citationRows) {
      const articleResult = await client.query(ARTICLE_UPSERT, [
        row.canonicalUrl,
        row.originalUrl,
        row.title,
        row.domain,
        row.normalizedDomain,
      ]);
      const articleId = articleResult.rows[0].id;
      if (articleResult.rows[0].inserted) articlesCreated += 1;
      articleIds.add(articleId);

      await client.query(CITATION_UPSERT, [
        runId,
        articleId,
        row.sourcePosition,
        row.citationMarker,
        row.answerText,
        row.relationStatus,
        row.capturedFrom,
        row.visibleToUser,
      ]);
    }

    await client.query("COMMIT");

    return {
      projectId,
      promptId,
      runId,
      articlesReferenced: articleIds.size,
      articlesCreated,
      articlesReused: articleIds.size - articlesCreated,
      citationsWritten: citationRows.length,
      citationsSkipped: skipped.length,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof DatabasePersistError) throw error;
    throw new DatabasePersistError(
      `Failed to persist run ${run?.id ?? "<unknown>"}: ${error.message}`,
      { cause: error },
    );
  } finally {
    client.release();
  }
}
