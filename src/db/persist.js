import { looksTruncatedAnswer } from "../answer-quality.js";
import { canonicalizeUrl, domainFromUrl } from "../url.js";
import { normalizeDomain } from "./domain.js";
import { persistRetrievalEvidence } from "./persist-retrieval.js";

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

// prompts identity is (project_id, prompt_md5) for pool rows and
// (project_id, prompt_md5, external_id) for caller-tagged rows (migration 0023), because
// those are two partial unique indexes the ON CONFLICT target has to match exactly.
const PROMPT_UPSERT = `
  INSERT INTO prompts (project_id, prompt, external_id, enabled)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT (project_id, prompt_md5) WHERE external_id IS NULL DO UPDATE
    SET updated_at = now(),
        external_id = COALESCE(EXCLUDED.external_id, prompts.external_id),
        enabled = EXCLUDED.enabled
  RETURNING id
`;

const PROMPT_UPSERT_WITH_EXTERNAL_ID = `
  INSERT INTO prompts (project_id, prompt, external_id, enabled)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT (project_id, prompt_md5, external_id) WHERE external_id IS NOT NULL DO UPDATE
    SET updated_at = now(),
        enabled = EXCLUDED.enabled
  RETURNING id
`;

function promptUpsertSql(externalId) {
  return externalId == null ? PROMPT_UPSERT : PROMPT_UPSERT_WITH_EXTERNAL_ID;
}

const ACCOUNT_UPSERT = `
  INSERT INTO accounts (account_key, provider)
  VALUES ($1, $2)
  ON CONFLICT (provider, account_key) DO UPDATE
    SET updated_at = now()
  RETURNING id
`;

const RUN_UPSERT = `
  INSERT INTO runs (
    prompt_id, provider, status, started_at, finished_at, answer,
    expected_citation_count, captured_citation_count, citation_state, citation_diagnostics,
    submission_method, conversation_reset, current_url, error_code, error_message, error_details,
    local_run_id, artifact_path,
    sampling_batch_id, account_key, conversation_reset_confirmed,
    brand_mentioned, mention_count, first_mention_position, matched_terms, brand_detection_version,
    run_token, job_id, attempt, login_state, answer_truncated, request_slot,
    last_attempt_started_at
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb,
          $11, $12, $13, $14, $15, $16::jsonb, $17, $18,
          $19, $20, $21, $22, $23, $24, $25::jsonb, $26,
          $27, $28, $29, $30, $31, $32,
          $4)
  ON CONFLICT (local_run_id) DO UPDATE
    SET prompt_id = EXCLUDED.prompt_id,
        provider = EXCLUDED.provider,
        status = EXCLUDED.status,
        -- started_at 保留**首次**被处理的时间，不再被重试覆盖。原先写成
        -- started_at = EXCLUDED.started_at，于是每重试一次这个字段就被推后一次，
        -- 而 finished_at 是最后一次的结束 —— 两者一减得到的根本不是任何一次的真实耗时。
        -- 实测出现过 19:10:20 ~ 23:11:48 这种 4 小时的"耗时"，那条实际只跑了几分钟。
        -- 用 LEAST 保留最早的那个：它回答「这条任务第一次是什么时候被碰的」。
        started_at = LEAST(runs.started_at, EXCLUDED.started_at),
        -- 最后一次尝试的时刻单独记。「这条跑了多久」应当用
        -- finished_at - last_attempt_started_at，而不是减 started_at。
        last_attempt_started_at = EXCLUDED.started_at,
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
        artifact_path = EXCLUDED.artifact_path,
        sampling_batch_id = EXCLUDED.sampling_batch_id,
        account_key = EXCLUDED.account_key,
        conversation_reset_confirmed = EXCLUDED.conversation_reset_confirmed,
        login_state = EXCLUDED.login_state,
        brand_mentioned = EXCLUDED.brand_mentioned,
        mention_count = EXCLUDED.mention_count,
        first_mention_position = EXCLUDED.first_mention_position,
        matched_terms = EXCLUDED.matched_terms,
        brand_detection_version = EXCLUDED.brand_detection_version,
        run_token = COALESCE(EXCLUDED.run_token, runs.run_token),
        job_id = COALESCE(EXCLUDED.job_id, runs.job_id),
        attempt = EXCLUDED.attempt,
        answer_truncated = EXCLUDED.answer_truncated
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

// `provider` 用子查询从 runs 取，而不是让调用方多传一个参数：本语句在 `RUN_UPSERT` 之后
// 执行（见 persistRun 里 289 行先写 run、352 行再写 citations），所以同一个事务里一定能读到。
// 补这一列是为了让 citations **自带平台维度** —— 它是单独交给运营分析的那张表，
// 只靠 run_id 关联意味着一旦单独导出就丢了「这条引用来自哪个平台」。
const CITATION_UPSERT = `
  INSERT INTO citations (
    run_id, article_id, source_position, citation_marker, answer_text,
    relation_status, captured_from, visible_to_user, tracked_article_id, source_type,
    provider
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          (SELECT provider FROM runs WHERE id = $1))
  ON CONFLICT (run_id, source_position) DO UPDATE
    SET article_id = EXCLUDED.article_id,
        citation_marker = EXCLUDED.citation_marker,
        answer_text = EXCLUDED.answer_text,
        relation_status = EXCLUDED.relation_status,
        captured_from = EXCLUDED.captured_from,
        visible_to_user = EXCLUDED.visible_to_user,
        tracked_article_id = EXCLUDED.tracked_article_id,
        source_type = EXCLUDED.source_type,
        provider = EXCLUDED.provider
`;

const ALLOWED_RELATION_STATUS = new Set(["matched", "unresolved"]);

// 'retrieved' 只能由确实拿到、但无法确认 UI 可见的来源显式标注。
// 默认永远是 'visible'——绝不把 retrieved 自动升级成可见引用。
const ALLOWED_SOURCE_TYPES = new Set(["visible", "retrieved"]);

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

  const unsupportedSources = [
    ...new Set(
      citations
        .map((citation) => citation?.sourceType)
        .filter((value) => value != null && !ALLOWED_SOURCE_TYPES.has(value)),
    ),
  ];
  if (unsupportedSources.length) {
    throw new DatabasePersistError(
      `Unsupported sourceType value(s): ${unsupportedSources.join(", ")}. ` +
        "The schema only accepts 'visible' or 'retrieved'.",
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
      // 未标注的一律按可见引用处理，因为当前所有抓取路径都是 DOM 可见引用。
      sourceType: ALLOWED_SOURCE_TYPES.has(citation.sourceType) ? citation.sourceType : "visible",
    });
  });

  return { rows, skipped };
}

/** Registers the anonymous account identifiers a batch uses. No credentials here. */
export async function ensureAccounts(pool, { accountKeys, provider = "doubao" }) {
  if (!accountKeys?.length) return [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ids = [];
    for (const accountKey of accountKeys) {
      const result = await client.query(ACCOUNT_UPSERT, [accountKey, provider]);
      ids.push({ accountKey, id: result.rows[0].id });
    }
    await client.query("COMMIT");
    return ids;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw new DatabasePersistError(`Failed to register accounts: ${error.message}`, {
      cause: error,
    });
  } finally {
    client.release();
  }
}

export async function recordAccountHealth(pool, { accountKey, provider = "doubao", status }) {
  if (!accountKey) return;
  await pool.query(
    `UPDATE accounts
        SET last_health_status = $3, last_health_checked_at = now(), updated_at = now()
      WHERE provider = $2 AND account_key = $1`,
    [accountKey, provider, status],
  );
}

/**
 * Writes one collector run into PostgreSQL as a single all-or-nothing transaction.
 *
 * Ordering follows the pipeline: upsert Project and Prompt, upsert the Run, then
 * upsert each Article and attach a Citation. Network retrieval evidence is written in
 * the same transaction but remains in its own tables; it is never promoted to a Citation.
 */
export async function persistRun({
  pool,
  run,
  project = null,
  prompt = null,
  artifactPath = null,
  accountKey = null,
  samplingBatchId = null,
  runToken = null,
  jobId = null,
  attempt = null,
  requestSlot = null,
}) {
  if (!pool) throw new DatabasePersistError("persistRun requires a connection pool");

  const citations = Array.isArray(run?.citations) ? run.citations : [];
  const { rows: citationRows, skipped } = prepareCitations(citations);
  const projectName = project || run?.project || "default";
  const effectiveAccountKey = accountKey ?? run?.accountKey ?? null;
  const effectiveBatchId = samplingBatchId ?? run?.samplingBatchId ?? null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const projectResult = await client.query(PROJECT_UPSERT, [projectName, null]);
    const projectId = projectResult.rows[0].id;

    const promptResult = await client.query(promptUpsertSql(prompt?.externalId ?? null), [
      projectId,
      run?.prompt ?? "",
      prompt?.externalId ?? null,
      prompt?.enabled !== false,
    ]);
    const promptId = promptResult.rows[0].id;

    // Tracked articles are matched on canonical URL exact equality in this phase.
    const trackedResult = await client.query(
      "SELECT id, canonical_url FROM tracked_articles WHERE project_id = $1",
      [projectId],
    );
    const trackedByUrl = new Map(
      trackedResult.rows.map((row) => [row.canonical_url, row.id]),
    );

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
      effectiveBatchId,
      effectiveAccountKey,
      run?.conversationResetConfirmed ?? null,
      run?.brandMentioned ?? null,
      run?.mentionCount ?? null,
      run?.firstMentionPosition ?? null,
      JSON.stringify(Array.isArray(run?.matchedTerms) ? run.matchedTerms : []),
      run?.brandDetectionVersion ?? null,
      runToken ?? run?.runToken ?? null,
      jobId ?? run?.jobId ?? null,
      attempt ?? run?.attempt ?? 1,
      // 'account' is the safe default: a run that never declared its surface was collected the
      // way OneGl has always worked, and silently labelling it anonymous would invent a
      // partition that was never measured.
      run?.loginState === "anonymous" ? "anonymous" : "account",
      // A hint, so a half-sentence capture can be excluded from rates instead of counted as one.
      looksTruncatedAnswer(run?.answer),
      // 这一次采集实际跑在哪个并发槽位。指纹轮换的计数按槽位分开，见 migrations/0028。
      Number.isInteger(requestSlot) && requestSlot >= 0 ? requestSlot : 0,
    ]);
    const runId = runResult.rows[0].id;

    // Re-persisting the same run must converge, not accumulate.
    await client.query("DELETE FROM citations WHERE run_id = $1", [runId]);

    let articlesCreated = 0;
    let trackedCitations = 0;
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

      const trackedArticleId = trackedByUrl.get(row.canonicalUrl) ?? null;
      if (trackedArticleId) trackedCitations += 1;

      await client.query(CITATION_UPSERT, [
        runId,
        articleId,
        row.sourcePosition,
        row.citationMarker,
        row.answerText,
        row.relationStatus,
        row.capturedFrom,
        row.visibleToUser,
        trackedArticleId,
        row.sourceType,
      ]);
    }

    const retrieval = await persistRetrievalEvidence({ client, runId, run });

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
      trackedCitations,
      ...retrieval,
      accountKey: effectiveAccountKey,
      samplingBatchId: effectiveBatchId,
      runToken: runToken ?? run?.runToken ?? null,
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
