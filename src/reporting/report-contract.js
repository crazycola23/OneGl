import crypto from "node:crypto";

import { supportedProviderIds } from "../providers/index.js";

/**
 * Public, strictly-typed report contract.
 *
 * `GET /v1/reports/{id}` grew out of the internal dashboard payload and carries raw SQL rows
 * with internal identifiers in them. This module builds a *closed* object instead: every key it
 * emits is declared, nothing is passed through untouched, and the internal identifier set below
 * can never appear anywhere in the result.
 *
 * Two things are deliberately kept apart here that the raw report conflates:
 *   - `collection` — did OneGl ask Doubao the question and capture an answer?
 *   - `analysis`   — has the background cited-page pass finished for that answer set?
 * `readiness` is derived from both, so `collection` reaching a terminal state no longer means
 * "the report is finished".
 */

export const REPORT_CONTRACT_SCHEMA_VERSION = "report-contract-v1";
export const REPORT_CONTRACT_PROVIDER = "doubao_web";
export const REPORT_CONTRACT_SOURCE = "onegl";
export const REPORT_CONTRACT_SUMMARY_VERSION = 1;
export const REPORT_CONTRACT_RENDERER_VERSION = "optimization-html-v1";

/**
 * Which platform produced this report.
 *
 * The published v1 value for Doubao is "doubao_web", so a web surface is named
 * `<provider>_web` and existing consumers keep reading the same string. Hardcoding it instead
 * would stamp a Qianwen report as Doubao output, which is a provenance error rather than a
 * formatting one.
 */
export function reportContractProvider(batch = {}) {
  const provider = text(batch.provider);
  return provider ? `${provider}_web` : REPORT_CONTRACT_PROVIDER;
}

/**
 * Every value reportContractProvider can emit. The OpenAPI provenance schema reads this list,
 * so the contract cannot promise a provenance the producer cannot generate - nor pin reports
 * to one platform while the collector serves several.
 */
export function reportContractProviders() {
  return supportedProviderIds().map((provider) => `${provider}_web`).sort();
}

/** Caps owned by the underlying queries; a consumer must not read a capped list as a census. */
export const REPORT_CONTRACT_LIMITS = Object.freeze({
  runs: 500,
  sourceAggregates: 15,
  topList: 10,
});

const INTERNAL_KEYS = Object.freeze(new Set([
  "id",
  "ids",
  "account_keys",
  "account_key",
  "account",
  "accounts",
  "project_id",
  "project",
  "monitor_execution_id",
  "pool_size",
  "pool_version",
  "sample_size",
  "sampling_seed",
  "source_intelligence_generation",
  "source_intelligence_status",
  "source_intelligence_queued_at",
  "source_intelligence_started_at",
  "source_intelligence_finished_at",
  "source_intelligence_error",
  "batchId",
  "batch_id",
  "sampling_batch_id",
  "localRunId",
  "local_run_id",
  "run_id",
  "runId",
  "run_db_id",
  "tracked_article_id",
  "prompt_id",
  "promptId",
  "article_id",
  "articleId",
  "article_ids",
  "citation_id",
  "tenant_id",
  "tenantId",
  "task_internal_id",
  "execution_internal_id",
  "report_internal_id",
  "storage_state",
  "storageState",
  "cookie",
  "cookies",
  "api_key",
  "signing_secret",
]));

const TERMINAL_BATCH_STATUSES = new Set(["completed", "partial", "failed", "aborted"]);
const OPEN_ANALYSIS_STATUSES = new Set(["idle", "queued", "running"]);

function num(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value) {
  return value == null ? null : String(value);
}

/**
 * Recursively drop every internal identifier. The projections below are already whitelisted;
 * this is the net that catches a field a future SQL change adds to a shared query.
 */
export function scrubInternalIdentifiers(value) {
  if (Array.isArray(value)) return value.map((item) => scrubInternalIdentifiers(item));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      if (INTERNAL_KEYS.has(key)) continue;
      out[key] = scrubInternalIdentifiers(inner);
    }
    return out;
  }
  return value;
}

function deepSort(value) {
  if (Array.isArray(value)) return value.map(deepSort);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = deepSort(value[key]);
    return out;
  }
  return value;
}

/** Canonical JSON: recursive key sort, then the ordinary stringifier. No new dependency. */
export function canonicalJson(value) {
  return JSON.stringify(deepSort(value)) ?? "null";
}

/**
 * Two revisions of the same report must collide when nothing measurable changed, so the
 * volatile fields (which revision number this is, and the wall-clock of the read) are excluded
 * from the hash even though they stay in the stored payload.
 */
export function hashableContract(contract) {
  const clone = structuredClone(contract);
  delete clone.revision;
  if (clone.provenance) delete clone.provenance.generated_at;
  return clone;
}

export function contractContentHash(contract) {
  return crypto.createHash("sha256").update(canonicalJson(hashableContract(contract))).digest("hex");
}

function truncation({ rows, limit }) {
  const length = Array.isArray(rows) ? rows.length : 0;
  return {
    truncated: limit != null && length >= limit,
    limit: limit ?? null,
    returned: length,
  };
}

function contractBatch(batch = {}) {
  return {
    name: text(batch.name),
    provider: text(batch.provider),
    status: text(batch.status),
    sampling_method: text(batch.sampling_method),
    repeats: nullableNumber(batch.repeats),
    requested_jobs: nullableNumber(batch.requested_jobs),
    completed_jobs: nullableNumber(batch.completed_jobs),
    failed_jobs: nullableNumber(batch.failed_jobs),
    skipped_jobs: nullableNumber(batch.skipped_jobs),
    project_name: text(batch.project_name),
    target_brand: text(batch.target_brand),
    queued_at: batch.queued_at ?? null,
    started_at: batch.started_at ?? null,
    finished_at: batch.finished_at ?? null,
    aborted_at: batch.aborted_at ?? null,
    created_at: batch.created_at ?? null,
  };
}

function contractTrackedArticle(row = {}) {
  return {
    canonical_url: text(row.canonical_url),
    title: text(row.title),
    domain: text(row.domain),
    citations: num(row.citations),
    runs: num(row.runs),
    prompts: num(row.prompts),
    account_count: num(row.accounts),
    first_seen_at: row.first_seen_at ?? null,
    last_seen_at: row.last_seen_at ?? null,
  };
}

function contractTopArticle(row = {}) {
  return {
    canonical_url: text(row.canonical_url),
    title: text(row.title),
    domain: text(row.domain),
    citations: num(row.citations),
    runs: num(row.runs),
  };
}

function contractTopDomain(row = {}) {
  return { domain: text(row.domain), citations: num(row.citations), articles: num(row.articles), runs: num(row.runs) };
}

function contractSourceAggregateRow(row = {}) {
  return {
    canonical_url: text(row.canonical_url),
    title: text(row.title),
    domain: text(row.domain ?? row.normalized_domain),
    citations: num(row.citations),
    runs: num(row.runs),
    prompts: num(row.prompts),
    articles: nullableNumber(row.articles),
    is_tracked: row.is_tracked == null ? null : Boolean(row.is_tracked),
  };
}

function contractFailure(row = {}) {
  return { error_code: text(row.error_code), runs: num(row.runs) };
}

function contractCategory(row = {}) {
  return {
    category: text(row.category),
    valid_runs: num(row.validRuns),
    mentioned: num(row.mentioned),
    mention_rate: row.mentionRate == null ? null : Number(row.mentionRate),
  };
}

/**
 * `byAccount` is keyed by OneGl's internal account key. A consumer still needs to be able to
 * compare collectors against each other, so the stable part (the per-slot numbers) is kept and
 * the key itself is replaced by an opaque slot label derived from a sorted position.
 */
function contractByAccount(rows = []) {
  const sorted = [...rows].sort((a, b) => String(a.account ?? "").localeCompare(String(b.account ?? "")));
  return sorted.map((row, index) => ({
    slot: `account-${index + 1}`,
    valid_runs: num(row.validRuns),
    mentioned: num(row.mentioned),
    mention_rate: row.mentionRate == null ? null : Number(row.mentionRate),
    prompts: num(row.prompts),
    citations: num(row.citations),
  }));
}

function contractCitationFactors(factors) {
  if (!factors || typeof factors !== "object") return null;
  const { batchId, ...rest } = factors;
  return scrubInternalIdentifiers(rest);
}

function contractRunRow(row = {}, identity = null) {
  return {
    result_id: identity?.result_id ?? null,
    question: text(row.prompt),
    question_external_id: identity?.external_id ?? null,
    repetition_index: identity?.repetition_index == null ? null : Number(identity.repetition_index),
    repetition_count: identity?.repetition_count == null ? null : Number(identity.repetition_count),
    category: text(row.category),
    status: text(row.status),
    started_at: row.started_at ?? null,
    finished_at: row.finished_at ?? null,
    brand_mentioned: row.brand_mentioned == null ? null : Boolean(row.brand_mentioned),
    mention_count: nullableNumber(row.mention_count),
    expected_citation_count: nullableNumber(row.expected_citation_count),
    captured_citation_count: nullableNumber(row.captured_citation_count),
    citation_state: text(row.citation_state),
    conversation_reset: row.conversation_reset == null ? null : Boolean(row.conversation_reset),
    conversation_reset_confirmed: row.conversation_reset_confirmed == null
      ? null
      : Boolean(row.conversation_reset_confirmed),
    error_code: text(row.error_code),
    attempt: nullableNumber(row.attempt),
    answer_chars: nullableNumber(row.answer_chars),
  };
}

function contractSource(row = {}) {
  return {
    canonical_url: text(row.canonicalUrl),
    original_url: text(row.originalUrl),
    final_url: text(row.finalUrl),
    title: text(row.title),
    domain: text(row.domain),
    citation_count: num(row.citationCount),
    run_count: num(row.runCount),
    prompt_count: num(row.promptCount),
    average_position: row.averagePosition == null ? null : Number(row.averagePosition),
    prompts: Array.isArray(row.prompts) ? row.prompts.map((item) => text(item)) : [],
    page: contractPage(row.page),
  };
}

function contractPage(page) {
  if (!page || typeof page !== "object") return null;
  return {
    fetch_state: text(page.fetchState),
    content_excerpt: text(page.contentExcerpt),
    content_profile: page.contentProfile ?? null,
    outline: Array.isArray(page.outline) ? page.outline : [],
    paragraph_count: nullableNumber(page.paragraphCount),
    text_length: nullableNumber(page.textLength),
    h1_count: nullableNumber(page.h1Count),
    h2_count: nullableNumber(page.h2Count),
    h3_count: nullableNumber(page.h3Count),
    table_count: nullableNumber(page.tableCount),
    list_count: nullableNumber(page.listCount),
    faq_heading_count: nullableNumber(page.faqHeadingCount),
    author_present: page.authorPresent == null ? null : Boolean(page.authorPresent),
    published_at_raw: text(page.publishedAtRaw),
    modified_at_raw: text(page.modifiedAtRaw),
    brand_mentioned: page.brandMentioned == null ? null : Boolean(page.brandMentioned),
    brand_mention_count: nullableNumber(page.brandMentionCount),
    brand_first_mention_position: nullableNumber(page.brandFirstMentionPosition),
    brand_matched_terms: Array.isArray(page.brandMatchedTerms) ? page.brandMatchedTerms : [],
    brand_contexts: Array.isArray(page.brandContexts) ? page.brandContexts : [],
    brand_locations: Array.isArray(page.brandLocations) ? page.brandLocations : [],
    brand_detection_version: text(page.brandDetectionVersion),
  };
}

/**
 * Page analysis rows keep the intelligence module's own camelCase field names on purpose: the
 * stored payload has to be re-renderable by `buildOptimizationHtmlReport` without a translation
 * layer, and those names are already the dashboard's public vocabulary.
 */
function contractQuery(row = {}) {
  return {
    prompt: text(row.prompt),
    category: text(row.category),
    valid_runs: num(row.validRuns),
    ai_brand_mentioned_runs: num(row.aiBrandMentionedRuns),
    ai_brand_mention_rate: row.aiBrandMentionRate == null ? null : Number(row.aiBrandMentionRate),
    ai_brand_mention_count: num(row.aiBrandMentionCount),
    citation_count: num(row.citationCount),
    unique_source_count: num(row.uniqueSourceCount),
    brand_evidence_source_count: num(row.brandEvidenceSourceCount),
    top_sources: (Array.isArray(row.topSources) ? row.topSources : []).map((item) => ({
      url: text(item.url),
      title: text(item.title),
      domain: text(item.domain),
      citations: num(item.citations),
    })),
    example_answer: text(row.exampleAnswer),
    example_answer_contains_brand: Boolean(row.exampleAnswerContainsBrand),
  };
}

/**
 * `sources` here are already contracted, so the page keys are the public snake_case ones
 * (`fetch_state` / `content_profile` / `brand_mentioned`). Reading the raw camelCase names
 * silently matched nothing and made every brand-evidence count 0.
 */
function isBrandEvidenceSource(source) {
  const page = source?.page;
  return page?.fetch_state === "success"
    && page.content_profile
    && typeof page.content_profile === "object"
    && Object.keys(page.content_profile).length > 0
    && page.brand_mentioned === true;
}

function withBrandEvidence(sources) {
  return sources.filter(isBrandEvidenceSource);
}

function contractDomains(sources) {
  const map = new Map();
  for (const source of sources) {
    const domain = source.domain || "(unknown)";
    const row = map.get(domain) ?? { domain, citations: 0, sources: 0, prompts: new Set(), brandEvidenceSources: 0 };
    row.citations += source.citation_count;
    row.sources += 1;
    for (const prompt of source.prompts) row.prompts.add(prompt);
    if (isBrandEvidenceSource(source)) row.brandEvidenceSources += 1;
    map.set(domain, row);
  }
  return [...map.values()].map((row) => ({
    domain: row.domain,
    citations: row.citations,
    sources: row.sources,
    prompt_count: row.prompts.size,
    brand_evidence_sources: row.brandEvidenceSources,
  })).sort((a, b) => b.citations - a.citations || b.sources - a.sources || String(a.domain).localeCompare(String(b.domain)));
}

/** numerator / denominator / measured so a 0 denominator is "unmeasured", never "0%". */
function metric(numerator, denominator, { label, kind = "rate" } = {}) {
  const n = num(numerator);
  const d = num(denominator);
  return {
    label: label ?? null,
    kind,
    numerator: n,
    denominator: d,
    measured: d > 0,
    value: d > 0 ? n / d : null,
  };
}

function contractQuality({ report, intelligence }) {
  const coverage = intelligence.coverage ?? {};
  const runs = report.runs ?? {};
  const prompts = report.prompts ?? {};
  const citations = report.citations ?? {};
  return {
    run_brand_mention_rate: metric(runs.mentioned, runs.valid, {
      label: "RUN 级品牌提及率：有效回答里出现目标品牌的比例",
    }),
    prompt_brand_coverage: metric(prompts.mentioned, prompts.total, {
      label: "问题级品牌覆盖：至少被提及一次的去重问题数",
    }),
    citation_capture_rate: metric(citations.validRuns, runs.valid, {
      label: "引用可解析的回答比例（citation-valid run）",
    }),
    tracked_citation_rate: metric(report.tracked?.cited, report.tracked?.total, {
      label: "被跟踪文章至少被引用一次的比例",
    }),
    answer_capture_rate: metric(runs.valid, runs.assignmentsRun, {
      label: "分配到的问题里有多少条落库为有效回答（分母含未采集与失败）",
    }),
    collection_gap_rate: metric(runs.failed, runs.assignmentsRun, {
      label: "落库但以失败结束的采集占比",
    }),
    page_analysis_coverage: metric(coverage.analyzedSources, coverage.citedSources, {
      label: "被引用页面中已完成内容画像的比例",
    }),
    brand_evidence_rate: metric(coverage.brandEvidenceSources, coverage.analyzedSources, {
      label: "已分析页面中含目标品牌的比例（分母只含已分析页面，所以“页面未分析”不会被读成“品牌未提及”）",
    }),
    citation_evidence_rate: metric(coverage.citationValidRuns, coverage.answerValidRuns, {
      label: "回答级引用证据完整度",
    }),
  };
}

function contractAnalysis(intelligence) {
  const job = intelligence?.job ?? {};
  return {
    status: text(job.status) ?? "idle",
    generation: nullableNumber(job.generation) ?? 0,
    queued_at: job.queued_at ?? null,
    started_at: job.started_at ?? null,
    finished_at: job.finished_at ?? null,
    error: text(job.error),
    stale: Boolean(job.stale),
  };
}

function contractReadiness({ batchStatus, progress, analysis, quality, notes }) {
  const terminal = TERMINAL_BATCH_STATUSES.has(batchStatus);
  let status;
  if (batchStatus === "aborted") status = "cancelled";
  else if (!terminal) status = progress.total > 0 ? "collecting" : "empty";
  else if (batchStatus === "failed" && progress.completed === 0) status = "failed";
  else if (analysis.status === "queued" || analysis.status === "running") status = "analysis_running";
  else if (analysis.status === "idle" || analysis.stale) status = "collecting_complete";
  else {
    const gapped = progress.not_collected > 0
      || progress.failed > 0
      || analysis.status !== "completed"
      || quality.page_analysis_coverage.measured && quality.page_analysis_coverage.value < 1;
    status = gapped ? "complete_with_gaps" : "complete";
  }

  if (progress.total === 0) {
    notes.push("批次没有分配任何问题，报告为空。");
  }
  if (!terminal) {
    notes.push(`采集仍在进行（batch ${batchStatus ?? "unknown"}），当前数字只是过程快照。`);
  }
  if (progress.not_collected > 0) {
    notes.push(`${progress.not_collected}/${progress.total} 个分配在批次终止时没有采集记录，已计为 not_collected，不会永远停留在 pending。`);
  }
  if (progress.failed > 0) {
    notes.push(`${progress.failed} 个采集任务以失败结束，其 terminal_reason 给出了错误码。`);
  }
  if (batchStatus === "failed") {
    notes.push("批次以 failed 结束；已完成的回答仍然可用。");
  }
  if (analysis.status === "idle") notes.push("引用页内容分析尚未调度；readiness 停在 collecting_complete。");
  if (analysis.status === "queued" || analysis.status === "running") {
    notes.push("引用页内容分析进行中；品牌证据与结构指标会随其完成而变化。");
  }
  if (analysis.status === "failed") notes.push(`引用页内容分析失败：${analysis.error ?? "未提供原因"}；AI 回答与引用统计不受影响。`);
  if (analysis.status === "partial") notes.push(`部分引用页未完成分析：${analysis.error ?? "未提供原因"}。`);
  if (analysis.stale) notes.push("引用页分析结果落后于当前批次结束时间，等待后台补偿调度。");
  if (!quality.page_analysis_coverage.measured && progress.total > 0) {
    notes.push("没有任何被引用页面完成内容分析，品牌证据类指标不可测量（不是 0）。");
  }
  return { status, explainable: true, notes };
}

/**
 * @param {object} args
 * @param {object} args.detail      batchDetail() output: { report, runs, sources, intelligence }
 * @param {object} args.execution   getExecution() output (may be null for a CLI/offline build)
 * @param {object} args.report      service_reports row joined with task/execution public ids
 * @param {number} args.revision    revision number this payload represents (0 = not stored yet)
 * @param {Array}  [args.resultIdentities] listBatchResultIdentities() output
 */
export function buildReportContract({ detail, execution = null, report = {}, revision = 0, generatedAt = null } = {}) {
  const source = detail ?? {};
  const batchReport = source.report ?? {};
  const intelligence = source.intelligence ?? null;
  const sourceAggregates = source.sources ?? {};
  const runRows = Array.isArray(source.runs) ? source.runs : [];
  const identities = Array.isArray(source.resultIdentities) ? source.resultIdentities : [];
  const identityByRun = new Map(identities.map((row) => [row.run_id, row]));
  const batch = batchReport.batch ?? {};

  const runs = runRows.map((row) => contractRunRow(row, identityByRun.get(row.local_run_id) ?? null));
  const queries = (Array.isArray(intelligence?.queries) ? intelligence.queries : []).map(contractQuery);
  const sources = (Array.isArray(intelligence?.sources) ? intelligence.sources : []).map(contractSource);
  const domains = contractDomains(sources);
  const structure = intelligence?.structure
    ? { ...intelligence.structure, profileTypes: intelligence.structure.profileTypes ?? [], commonStructures: intelligence.structure.commonStructures ?? [] }
    : null;

  const progress = execution?.progress ?? {
    total: num(batch.requested_jobs),
    completed: num(batch.completed_jobs),
    failed: num(batch.failed_jobs),
    skipped: num(batch.skipped_jobs),
    not_collected: 0,
  };
  const analysis = contractAnalysis(intelligence);
  const quality = contractQuality({ report: batchReport, intelligence: intelligence ?? {} });
  const notes = [];
  const readiness = contractReadiness({
    batchStatus: batch.status ?? execution?.status ?? null,
    progress,
    analysis,
    quality,
    notes,
  });

  const trackedArticleRows = Array.isArray(batchReport.tracked?.articles) ? batchReport.tracked.articles : [];
  const topArticles = Array.isArray(batchReport.topArticles) ? batchReport.topArticles : [];
  const topDomains = Array.isArray(batchReport.topDomains) ? batchReport.topDomains : [];
  const sourceDomains = Array.isArray(sourceAggregates.domains) ? sourceAggregates.domains : [];
  const sourceArticles = Array.isArray(sourceAggregates.articles) ? sourceAggregates.articles : [];

  const contract = {
    report_id: report.public_id ?? report.report_id ?? null,
    task_id: report.task_public_id ?? report.task_id ?? null,
    execution_id: report.execution_public_id ?? report.execution_id ?? null,
    revision: num(revision),
    schema_version: REPORT_CONTRACT_SCHEMA_VERSION,
    versions: {
      schema: REPORT_CONTRACT_SCHEMA_VERSION,
      intelligence: intelligence?.version == null ? null : Number(intelligence.version),
      summary: REPORT_CONTRACT_SUMMARY_VERSION,
      renderer: REPORT_CONTRACT_RENDERER_VERSION,
    },
    provenance: {
      provider: reportContractProvider(batch),
      contract_version: REPORT_CONTRACT_SCHEMA_VERSION,
      generated_at: generatedAt ?? new Date().toISOString(),
      source: REPORT_CONTRACT_SOURCE,
    },
    collection: {
      status: execution?.status ?? (batch.status ? (batch.status === "aborted" ? "cancelled" : batch.status) : "pending"),
      started_at: execution?.started_at ?? batch.started_at ?? null,
      finished_at: execution?.finished_at ?? batch.finished_at ?? null,
      progress: {
        total: num(progress.total),
        completed: num(progress.completed),
        failed: num(progress.failed),
        skipped: num(progress.skipped),
        not_collected: num(progress.not_collected),
      },
    },
    analysis,
    readiness,
    summary: {
      batch: contractBatch(batch),
      runs: batchReport.runs ?? { assignmentsRun: 0, valid: 0, partial: 0, failed: 0, unconfirmedReset: 0, mentioned: 0, mentionRate: null },
      prompts: batchReport.prompts ?? { total: 0, mentioned: 0, mentionCoverage: null },
      citations: batchReport.citations ?? { validRuns: 0, coverage: null, total: 0, articles: 0, domains: 0 },
      tracked: {
        total: num(batchReport.tracked?.total),
        cited: num(batchReport.tracked?.cited),
        citationRate: batchReport.tracked?.citationRate == null ? null : Number(batchReport.tracked.citationRate),
        articles: trackedArticleRows.map(contractTrackedArticle),
      },
      citationFactors: contractCitationFactors(batchReport.citationFactors),
      topArticles: topArticles.map(contractTopArticle),
      topDomains: topDomains.map(contractTopDomain),
      byCategory: (Array.isArray(batchReport.byCategory) ? batchReport.byCategory : []).map(contractCategory),
      byAccount: contractByAccount(batchReport.byAccount),
      failures: (Array.isArray(batchReport.failures) ? batchReport.failures : []).map(contractFailure),
      sourceDomains: sourceDomains.map(contractSourceAggregateRow),
      sourceArticles: sourceArticles.map(contractSourceAggregateRow),
      sourceTotals: {
        citations: num(sourceAggregates.totals?.citations),
        articles: num(sourceAggregates.totals?.articles),
        domains: num(sourceAggregates.totals?.domains),
      },
      intelligence: {
        version: intelligence?.version == null ? null : Number(intelligence.version),
        coverage: intelligence?.coverage ?? null,
        attributionNote: text(intelligence?.attributionNote),
        domains,
        brandEvidenceSources: withBrandEvidence(sources),
      },
    },
    queries,
    sources,
    structure,
    quality,
    runs,
    truncated: {
      runs: truncation({ rows: runs, limit: REPORT_CONTRACT_LIMITS.runs }),
      queries: truncation({ rows: queries, limit: null }),
      sources: truncation({ rows: sources, limit: null }),
      trackedArticles: truncation({ rows: trackedArticleRows, limit: null }),
      topArticles: truncation({ rows: topArticles, limit: REPORT_CONTRACT_LIMITS.topList }),
      topDomains: truncation({ rows: topDomains, limit: REPORT_CONTRACT_LIMITS.topList }),
      sourceDomains: truncation({ rows: sourceDomains, limit: REPORT_CONTRACT_LIMITS.sourceAggregates }),
      sourceArticles: truncation({ rows: sourceArticles, limit: REPORT_CONTRACT_LIMITS.sourceAggregates }),
    },
    totals: {
      assignments: num(batchReport.runs?.assignmentsRun),
      valid_runs: num(batchReport.runs?.valid),
      failed_runs: num(batchReport.runs?.failed),
      collected_results: runs.filter((row) => ["success", "partial"].includes(row.status)).length,
      not_collected_results: runs.filter((row) => row.status === "failed").length + Math.max(
        0,
        num(progress.total) - runRows.length,
      ),
      citations: num(batchReport.citations?.total),
      cited_articles: num(batchReport.citations?.articles),
      cited_domains: num(batchReport.citations?.domains),
      unique_sources: sources.length,
      analyzed_sources: num(intelligence?.coverage?.analyzedSources),
      brand_evidence_sources: num(intelligence?.coverage?.brandEvidenceSources),
      queries: queries.length,
    },
  };

  return scrubInternalIdentifiers(contract);
}

/**
 * Turn a stored contract back into the `{ report, runs, sources, intelligence }` shape the HTML
 * renderer reads, so a revision artifact is rendered from the frozen payload rather than from
 * whatever the live tables say now.
 */
export function contractToRenderDetail(contract = {}) {
  const summary = contract.summary ?? {};
  const sources = (Array.isArray(contract.sources) ? contract.sources : []).map((row) => ({
    canonicalUrl: row.canonical_url,
    originalUrl: row.original_url,
    finalUrl: row.final_url,
    title: row.title,
    domain: row.domain,
    citationCount: row.citation_count,
    runCount: row.run_count,
    promptCount: row.prompt_count,
    averagePosition: row.average_position,
    prompts: row.prompts ?? [],
    page: row.page ? {
      fetchState: row.page.fetch_state,
      contentExcerpt: row.page.content_excerpt,
      contentProfile: row.page.content_profile,
      outline: row.page.outline,
      paragraphCount: row.page.paragraph_count,
      textLength: row.page.text_length,
      h1Count: row.page.h1_count,
      h2Count: row.page.h2_count,
      h3Count: row.page.h3_count,
      tableCount: row.page.table_count,
      listCount: row.page.list_count,
      faqHeadingCount: row.page.faq_heading_count,
      authorPresent: row.page.author_present,
      publishedAtRaw: row.page.published_at_raw,
      modifiedAtRaw: row.page.modified_at_raw,
      brandMentioned: row.page.brand_mentioned,
      brandMentionCount: row.page.brand_mention_count,
      brandFirstMentionPosition: row.page.brand_first_mention_position,
      brandMatchedTerms: row.page.brand_matched_terms,
      brandContexts: row.page.brand_contexts,
      brandLocations: row.page.brand_locations,
      brandDetectionVersion: row.page.brand_detection_version,
    } : null,
  }));
  const intelligence = summary.intelligence ? {
    version: summary.intelligence.version ?? contract.versions?.intelligence ?? 1,
    job: {
      status: contract.analysis?.status ?? "idle",
      generation: contract.analysis?.generation ?? 0,
      queued_at: contract.analysis?.queued_at ?? null,
      started_at: contract.analysis?.started_at ?? null,
      finished_at: contract.analysis?.finished_at ?? null,
      error: contract.analysis?.error ?? null,
      stale: Boolean(contract.analysis?.stale),
    },
    queries: (contract.queries ?? []).map((row) => ({
      prompt: row.prompt,
      category: row.category,
      validRuns: row.valid_runs,
      aiBrandMentionedRuns: row.ai_brand_mentioned_runs,
      aiBrandMentionRate: row.ai_brand_mention_rate,
      aiBrandMentionCount: row.ai_brand_mention_count,
      citationCount: row.citation_count,
      uniqueSourceCount: row.unique_source_count,
      brandEvidenceSourceCount: row.brand_evidence_source_count,
      topSources: row.top_sources,
      exampleAnswer: row.example_answer,
      exampleAnswerContainsBrand: row.example_answer_contains_brand,
    })),
    sources,
    domains: summary.intelligence.domains ?? [],
    // `summary.intelligence.brandEvidenceSources` holds contracted (snake_case) rows; the
    // renderer reads the camelCase source shape built just above, so re-derive it from there
    // instead of handing it the stored payload.
    brandEvidenceSources: sources.filter((row) => row.page?.fetchState === "success"
      && row.page?.contentProfile
      && typeof row.page.contentProfile === "object"
      && Object.keys(row.page.contentProfile).length > 0
      && row.page.brandMentioned === true),
    structure: contract.structure ?? {},
    coverage: summary.intelligence.coverage ?? {},
    attributionNote: summary.intelligence.attributionNote ?? "",
    runs: [],
  } : null;

  return {
    report: { ...summary, tracked: summary.tracked ?? { total: 0, cited: 0, articles: [] } },
    runs: (contract.runs ?? []).map((row) => ({
      prompt: row.question,
      category: row.category,
      status: row.status,
      brand_mentioned: row.brand_mentioned,
      mention_count: row.mention_count,
      expected_citation_count: row.expected_citation_count,
      captured_citation_count: row.captured_citation_count,
      citation_state: row.citation_state,
      conversation_reset: row.conversation_reset,
      conversation_reset_confirmed: row.conversation_reset_confirmed,
      error_code: row.error_code,
      started_at: row.started_at,
      finished_at: row.finished_at,
      answer_chars: row.answer_chars,
    })),
    sources: {
      domains: summary.sourceDomains ?? [],
      articles: summary.sourceArticles ?? [],
      totals: summary.sourceTotals ?? { citations: 0, articles: 0, domains: 0 },
    },
    intelligence,
  };
}
