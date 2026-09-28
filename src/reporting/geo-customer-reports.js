import crypto from "node:crypto";

import { ApiHttpError } from "../api/http.js";
import { supportedProviderIds } from "../providers/index.js";
import { buildGeoCustomerReportHtml } from "../report/html-geo-customer.js";

const REPORT_SCHEMA_VERSION = "geo-customer-report.v1";
const REPORT_PROFILE_VERSION = "geo-customer-default.v1";
const DEFAULT_TIME_ZONE = "Asia/Shanghai";
const MAX_PERIODS = 8;
const MAX_PERIOD_DAYS = 366;
const HISTORY_MAX_LIMIT = 500;
const TERMINAL_BATCH_STATUSES = new Set(["completed", "partial", "failed", "aborted"]);
const ICON_DOMAINS = ["cdn.sm.cn", "gw.alicdn.com"];
const PLATFORM_COLORS = [
  "#2563eb", "#7c3aed", "#0e9f6e", "#d97706", "#0891b2",
  "#db2777", "#4f46e5", "#65a30d", "#dc2626", "#0f766e",
  "#9333ea", "#ca8a04", "#0284c7", "#c026d3", "#4d7c0f",
  "#ea580c", "#4338ca", "#059669", "#be123c", "#0e7490",
];

const asNumber = (value) => Number(value ?? 0);
const ratio = (numerator, denominator) => denominator > 0 ? numerator / denominator : null;
const nullableText = (value) => {
  const text = value == null ? "" : String(value).trim();
  return text || null;
};

function newPublicId(prefix) {
  return prefix + "_" + crypto.randomUUID().replaceAll("-", "");
}

function fail(message, status = 400, code = "invalid_request") {
  throw new ApiHttpError(status, code, message);
}

function isDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  if (value.startsWith("0000")) return false;
  const date = new Date(value + "T00:00:00.000Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function dayCount(from, to) {
  return Math.floor((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000) + 1;
}

function validTimeZone(value) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function onlyKeys(value, allowed, field) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) fail(field + " contains unsupported fields: " + unknown.join(", "));
}

function normalizePeriod(raw, index, seenKeys) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("periods[] must be objects");
  onlyKeys(raw, ["key", "label", "from", "to", "time_zone"], "periods[]");
  const from = String(raw.from ?? "");
  const to = String(raw.to ?? "");
  if (!isDate(from) || !isDate(to)) fail("periods[].from and periods[].to must be valid YYYY-MM-DD dates");
  if (to < from) fail("periods[].to must be on or after periods[].from");
  if (dayCount(from, to) > MAX_PERIOD_DAYS) fail("each period may span at most " + MAX_PERIOD_DAYS + " inclusive days");
  const timeZone = String(raw.time_zone ?? DEFAULT_TIME_ZONE).trim() || DEFAULT_TIME_ZONE;
  if (!validTimeZone(timeZone)) fail("periods[].time_zone must be a valid IANA time zone");
  const key = String(raw.key ?? ("phase-" + (index + 1))).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(key)) fail("periods[].key must be 1-64 URL-safe characters");
  if (seenKeys.has(key)) fail("periods[].key values must be unique");
  seenKeys.add(key);
  const label = nullableText(raw.label) ?? (from === to ? from : from + " 至 " + to);
  if (label.length > 100) fail("periods[].label must be at most 100 characters");
  return { key, label, from, to, time_zone: timeZone };
}

export function normalizeGeoCustomerReportRequest(input, taskPlatforms) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("request body must be a JSON object");
  onlyKeys(input, ["platforms", "periods", "format"], "request body");
  if (input.format != null && input.format !== "html") fail("format must be html");
  const supported = new Set(supportedProviderIds());
  const rawPlatforms = input.platforms ?? taskPlatforms;
  if (!Array.isArray(rawPlatforms) || rawPlatforms.length < 1 || rawPlatforms.length > 20) {
    fail("platforms must contain between 1 and 20 supported platforms");
  }
  const platforms = [...new Set(rawPlatforms.map((item) => String(item).trim().toLowerCase()))];
  if (platforms.length !== rawPlatforms.length) fail("platforms must not contain duplicates");
  const invalidPlatforms = platforms.filter((platform) => !supported.has(platform));
  if (invalidPlatforms.length) fail("unsupported platform: " + invalidPlatforms.join(", "), 422, "unsupported_platform");
  const rawPeriods = input.periods;
  if (!Array.isArray(rawPeriods) || rawPeriods.length < 1 || rawPeriods.length > MAX_PERIODS) {
    fail("periods must contain between 1 and " + MAX_PERIODS + " periods");
  }
  const seenKeys = new Set();
  const periods = rawPeriods.map((period, index) => normalizePeriod(period, index, seenKeys));
  return { platforms, periods, format: "html" };
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function stableStringify(value) {
  return JSON.stringify(stable(value));
}

function contentHash(payload) {
  return sha256(stableStringify(payload));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function publicDate(value) {
  if (value == null) return null;
  return new Date(value).toISOString();
}

async function taskAndProject(client, tenantId, publicTaskId) {
  const { rows } = await client.query(
    "SELECT t.id, t.project_id, t.public_id, t.name AS task_name, t.target_brand AS task_brand, t.platforms, " +
      "p.name AS project_name, p.target_brand AS project_brand " +
      "FROM service_tasks t JOIN projects p ON p.id = t.project_id " +
      "WHERE t.tenant_id = $1 AND t.public_id = $2",
    [tenantId, publicTaskId],
  );
  if (!rows[0]) fail("task was not found", 404, "task_not_found");
  return rows[0];
}

async function enabledTrackedArticles(client, projectId) {
  const { rows } = await client.query(
    "SELECT canonical_url, title, normalized_domain AS domain, count(*) OVER() AS configured_count " +
      "FROM tracked_articles WHERE project_id = $1 AND enabled IS TRUE " +
      "ORDER BY canonical_url LIMIT 500",
    [projectId],
  );
  const count = asNumber(rows[0]?.configured_count);
  return {
    count,
    truncated: count > rows.length,
    articles: rows.map((row) => ({
      canonical_url: row.canonical_url,
      title: row.title ?? null,
      domain: row.domain ?? null,
    })),
  };
}

async function periodBatches(client, { tenantId, taskDbId, platforms, period }) {
  const { rows } = await client.query(
    "SELECT e.public_id AS execution_id, b.id AS batch_db_id, b.provider AS platform, " +
      "b.status, b.started_at, b.finished_at, b.requested_jobs, b.completed_jobs, b.failed_jobs, b.skipped_jobs " +
      "FROM service_task_executions e JOIN sampling_batches b ON b.id = e.batch_id " +
      "WHERE e.tenant_id = $1 AND e.task_id = $2 AND b.provider = ANY($3::text[]) " +
      "AND b.started_at >= ($4::date::timestamp AT TIME ZONE $6) " +
      "AND b.started_at < (($5::date + 1)::timestamp AT TIME ZONE $6) " +
      "ORDER BY b.started_at, e.public_id",
    [tenantId, taskDbId, platforms, period.from, period.to, period.time_zone],
  );
  return rows;
}

async function queryRunMetrics(client, batchIds, brandConfigured) {
  const [assignmentResult, runResult] = await Promise.all([
    client.query(
      "SELECT count(*) AS assignments FROM sampling_batch_prompts WHERE batch_id = ANY($1::bigint[])",
      [batchIds],
    ),
    client.query(
      "SELECT count(*) AS runs, " +
        "count(*) FILTER (WHERE status IN ('success', 'partial') AND conversation_reset_confirmed IS TRUE) AS valid_runs, " +
        "count(*) FILTER (WHERE status = 'success' AND conversation_reset_confirmed IS TRUE " +
          "AND citation_state IN ('found', 'none_visible')) AS citation_valid_runs, " +
        "count(*) FILTER (WHERE status = 'partial') AS partial_runs, " +
        "count(*) FILTER (WHERE status = 'failed') AS failed_runs, " +
        "count(*) FILTER (WHERE status IN ('success', 'partial') AND conversation_reset_confirmed IS NOT TRUE) AS reset_unconfirmed_runs, " +
        "count(*) FILTER (WHERE status IN ('success', 'partial') AND conversation_reset_confirmed IS TRUE " +
          "AND answer IS NOT NULL AND btrim(answer) <> '') AS answers_with_text, " +
        "avg(char_length(answer)) FILTER (WHERE status IN ('success', 'partial') " +
          "AND conversation_reset_confirmed IS TRUE AND answer IS NOT NULL AND btrim(answer) <> '') AS average_answer_characters, " +
        "count(*) FILTER (WHERE status IN ('success', 'partial') AND conversation_reset_confirmed IS TRUE " +
          "AND brand_mentioned IS TRUE) AS mentioned_runs " +
        "FROM runs WHERE sampling_batch_id = ANY($1::bigint[])",
      [batchIds],
    ),
  ]);
  const assignments = asNumber(assignmentResult.rows[0]?.assignments);
  const row = runResult.rows[0] ?? {};
  const validRuns = asNumber(row.valid_runs);
  const citationValidRuns = asNumber(row.citation_valid_runs);
  return {
    assignments,
    runs: asNumber(row.runs),
    valid_runs: validRuns,
    citation_valid_runs: citationValidRuns,
    partial_runs: asNumber(row.partial_runs),
    failed_runs: asNumber(row.failed_runs),
    reset_unconfirmed_runs: asNumber(row.reset_unconfirmed_runs),
    answers_with_text: asNumber(row.answers_with_text),
    average_answer_characters: row.average_answer_characters == null ? null : Number(row.average_answer_characters),
    success_rate: ratio(validRuns, assignments),
    brand_mentioned_runs: brandConfigured ? asNumber(row.mentioned_runs) : null,
    brand_mention_rate: brandConfigured ? ratio(asNumber(row.mentioned_runs), validRuns) : null,
  };
}

function citationSourceSql() {
  return "WITH source_rows AS (" +
    " SELECT c.id AS citation_id, c.run_id, a.id AS article_id, a.canonical_url, a.title, " +
    "        a.normalized_domain AS domain, " +
    "        CASE WHEN EXISTS (SELECT 1 FROM unnest($3::text[]) AS icon_domain(value) " +
    "          WHERE lower(COALESCE(a.normalized_domain, '')) = icon_domain.value " +
    "             OR lower(COALESCE(a.normalized_domain, '')) LIKE '%.' || icon_domain.value) " +
    "        THEN TRUE ELSE FALSE END AS is_icon, " +
    "        (SELECT t.id FROM tracked_articles t WHERE t.project_id = $2 AND t.enabled IS TRUE " +
    "          AND (t.id = c.tracked_article_id OR (c.tracked_article_id IS NULL AND t.canonical_url = a.canonical_url)) " +
    "          ORDER BY (t.id = c.tracked_article_id) DESC LIMIT 1) AS tracked_article_id " +
    " FROM citations c JOIN runs r ON r.id = c.run_id JOIN articles a ON a.id = c.article_id " +
    " WHERE r.sampling_batch_id = ANY($1::bigint[]) AND r.status = 'success' " +
    "   AND r.conversation_reset_confirmed IS TRUE AND r.citation_state IN ('found', 'none_visible') " +
    "   AND c.source_type = 'visible' AND c.visible_to_user IS TRUE)";
}

async function queryCitationMetrics(client, batchIds, projectId, citationValidRuns, trackedCount) {
  const sourceSql = citationSourceSql();
  const [summaryResult, domainResult, articleResult] = await Promise.all([
    client.query(
      sourceSql + " SELECT count(*) AS visible_citations, " +
        "count(*) FILTER (WHERE is_icon IS FALSE) AS content_citations, " +
        "count(*) FILTER (WHERE is_icon IS TRUE) AS icon_citations, " +
        "count(DISTINCT article_id) FILTER (WHERE is_icon IS FALSE) AS unique_articles, " +
        "count(DISTINCT domain) FILTER (WHERE is_icon IS FALSE) AS unique_domains, " +
        "count(*) FILTER (WHERE is_icon IS FALSE AND tracked_article_id IS NOT NULL) AS tracked_citations, " +
        "count(DISTINCT run_id) FILTER (WHERE is_icon IS FALSE AND tracked_article_id IS NOT NULL) AS tracked_covered_runs, " +
        "count(DISTINCT tracked_article_id) FILTER (WHERE is_icon IS FALSE AND tracked_article_id IS NOT NULL) AS tracked_cited_articles " +
        "FROM source_rows",
      [batchIds, projectId, ICON_DOMAINS],
    ),
    client.query(
      sourceSql + " SELECT domain, count(*) AS citations, count(DISTINCT article_id) AS articles, " +
        "count(DISTINCT run_id) AS covered_runs FROM source_rows " +
        "WHERE is_icon IS FALSE AND domain IS NOT NULL AND domain <> '' " +
        "GROUP BY domain ORDER BY covered_runs DESC, citations DESC, domain LIMIT 12",
      [batchIds, projectId, ICON_DOMAINS],
    ),
    client.query(
      sourceSql + " SELECT canonical_url, title, domain, count(*) AS citations, " +
        "count(DISTINCT run_id) AS covered_runs FROM source_rows WHERE is_icon IS FALSE " +
        "GROUP BY canonical_url, title, domain " +
        "ORDER BY covered_runs DESC, citations DESC, canonical_url LIMIT 12",
      [batchIds, projectId, ICON_DOMAINS],
    ),
  ]);
  const row = summaryResult.rows[0] ?? {};
  const trackedCitedArticles = asNumber(row.tracked_cited_articles);
  return {
    citation_valid_runs: citationValidRuns,
    visible_citations: asNumber(row.visible_citations),
    content_citations: asNumber(row.content_citations),
    icon_citations: asNumber(row.icon_citations),
    unique_articles: asNumber(row.unique_articles),
    unique_domains: asNumber(row.unique_domains),
    tracked_content: {
      configured: trackedCount > 0,
      configured_articles: trackedCount,
      cited_articles: trackedCount > 0 && citationValidRuns > 0 ? trackedCitedArticles : null,
      citations: trackedCount > 0 && citationValidRuns > 0 ? asNumber(row.tracked_citations) : null,
      covered_runs: trackedCount > 0 && citationValidRuns > 0 ? asNumber(row.tracked_covered_runs) : null,
      coverage_rate: trackedCount > 0 ? ratio(asNumber(row.tracked_covered_runs), citationValidRuns) : null,
      article_coverage_rate: trackedCount > 0 && citationValidRuns > 0
        ? ratio(trackedCitedArticles, trackedCount)
        : null,
    },
    top_domains: domainResult.rows.map((item) => ({
      domain: item.domain,
      citations: asNumber(item.citations),
      unique_articles: asNumber(item.articles),
      covered_runs: asNumber(item.covered_runs),
      covered_run_rate: ratio(asNumber(item.covered_runs), citationValidRuns),
    })),
    top_articles: articleResult.rows.map((item) => ({
      canonical_url: item.canonical_url,
      title: item.title ?? null,
      domain: item.domain ?? null,
      citations: asNumber(item.citations),
      covered_runs: asNumber(item.covered_runs),
    })),
  };
}

async function queryTrackedArticleDetails(client, batchIds, projectId) {
  const { rows } = await client.query(
    "SELECT t.canonical_url, t.title, t.normalized_domain AS domain, " +
      "count(c.citation_id) AS citations, count(DISTINCT c.run_id) AS covered_runs, " +
      "count(*) OVER() AS configured_count " +
      "FROM tracked_articles t " +
      "LEFT JOIN LATERAL (" +
      " SELECT c.id AS citation_id, r.id AS run_id FROM articles a " +
      " JOIN citations c ON c.article_id = a.id " +
      " JOIN runs r ON r.id = c.run_id " +
      " WHERE t.project_id = $1 AND t.enabled IS TRUE " +
      "   AND (c.tracked_article_id = t.id OR (c.tracked_article_id IS NULL AND a.canonical_url = t.canonical_url)) " +
      "   AND r.sampling_batch_id = ANY($2::bigint[]) AND r.status = 'success' " +
      "   AND r.conversation_reset_confirmed IS TRUE AND r.citation_state IN ('found', 'none_visible') " +
      "   AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY['cdn.sm.cn', 'gw.alicdn.com']::text[]) AS icon_domain(value) " +
      "     WHERE lower(COALESCE(a.normalized_domain, '')) = icon_domain.value " +
      "        OR lower(COALESCE(a.normalized_domain, '')) LIKE '%.' || icon_domain.value) " +
      "   AND c.source_type = 'visible' AND c.visible_to_user IS TRUE" +
      ") c ON TRUE " +
      "WHERE t.project_id = $1 AND t.enabled IS TRUE " +
      "GROUP BY t.id ORDER BY covered_runs DESC, citations DESC, t.canonical_url LIMIT 200",
    [projectId, batchIds],
  );
  const count = asNumber(rows[0]?.configured_count);
  return {
    configured_count: count,
    truncated: count > rows.length,
    articles: rows.map((row) => ({
      canonical_url: row.canonical_url,
      title: row.title ?? null,
      domain: row.domain ?? null,
      citations: asNumber(row.citations),
      covered_runs: asNumber(row.covered_runs),
    })),
  };
}

async function queryQuestions(client, batchIds) {
  const { rows } = await client.query(
    "SELECT COALESCE(sr.question, p.prompt) AS question, " +
      "COALESCE(sbp.category, 'uncategorized') AS category, count(*) AS assignments " +
      "FROM sampling_batch_prompts sbp JOIN prompts p ON p.id = sbp.prompt_id " +
      "LEFT JOIN service_task_results sr ON sr.batch_id = sbp.batch_id " +
        "AND sr.selection_index = sbp.selection_index " +
      "WHERE sbp.batch_id = ANY($1::bigint[]) " +
      "GROUP BY COALESCE(sr.question, p.prompt), sbp.category " +
      "ORDER BY assignments DESC, category, question",
    [batchIds],
  );
  return rows.map((row) => ({ question: row.question, category: row.category, assignments: asNumber(row.assignments) }));
}

function emptyTrackedContent(trackedArticles) {
  return {
    configured: trackedArticles.count > 0,
    configured_articles: trackedArticles.count,
    cited_articles: null,
    citations: null,
    covered_runs: null,
    coverage_rate: null,
    article_coverage_rate: null,
    previous_period_key: null,
    coverage_delta_percentage_points: null,
    articles: trackedArticles.articles.map((article) => ({ ...article, citations: null, covered_runs: null })),
    truncated: trackedArticles.truncated,
  };
}

async function platformMetrics(client, { batchRows, projectId, brandConfigured, trackedArticles }) {
  const batchIds = batchRows.map((row) => Number(row.batch_db_id));
  if (!batchIds.length) {
    return {
      runs: {
        assignments: 0, runs: 0, valid_runs: 0, citation_valid_runs: 0,
        partial_runs: 0, failed_runs: 0, reset_unconfirmed_runs: 0,
        answers_with_text: 0, average_answer_characters: null, success_rate: null,
        brand_mentioned_runs: brandConfigured ? 0 : null, brand_mention_rate: null,
      },
      citations: {
        citation_valid_runs: 0, visible_citations: 0, content_citations: 0, icon_citations: 0,
        unique_articles: 0, unique_domains: 0, tracked_content: emptyTrackedContent(trackedArticles),
        top_domains: [], top_articles: [],
      },
      questions: [],
      source_batches: [],
    };
  }

  const runs = await queryRunMetrics(client, batchIds, brandConfigured);
  const citations = await queryCitationMetrics(client, batchIds, projectId, runs.citation_valid_runs, trackedArticles.count);
  const [trackedDetails, questions] = await Promise.all([
    queryTrackedArticleDetails(client, batchIds, projectId),
    queryQuestions(client, batchIds),
  ]);
  citations.tracked_content.configured = trackedDetails.configured_count > 0;
  citations.tracked_content.configured_articles = trackedDetails.configured_count;
  citations.tracked_content.articles = runs.citation_valid_runs > 0
    ? trackedDetails.articles
    : trackedDetails.articles.map((article) => ({ ...article, citations: null, covered_runs: null }));
  citations.tracked_content.truncated = trackedDetails.truncated;

  return { runs, citations, questions };
}

function comparePeriods(periods, platformIds) {
  for (const platformId of platformIds) {
    let previous = null;
    for (const period of periods) {
      const item = period.platforms.find((platform) => platform.platform === platformId);
      if (!item) continue;
      const currentRate = item.citations.tracked_content.coverage_rate;
      item.citations.tracked_content.previous_period_key = previous?.period_key ?? null;
      item.citations.tracked_content.coverage_delta_percentage_points =
        previous?.coverage_rate != null && currentRate != null
          ? Math.round((currentRate - previous.coverage_rate) * 10000) / 100
          : null;
      previous = { period_key: period.key, coverage_rate: currentRate };
    }
  }
}

function reportWarnings(periods, trackedArticles) {
  const warnings = [];
  if (trackedArticles.truncated) warnings.push("目标内容配置超过 500 条；报告只展开前 500 条配置项，收录率分母仍使用完整配置数。");
  for (const period of periods) {
    if (!period.source_batches.length) warnings.push("阶段“" + period.label + "”没有找到已结束的采集批次。");
    if (period.excluded_batches.length) {
      warnings.push("阶段“" + period.label + "”有 " + period.excluded_batches.length + " 个未结束批次，未计入指标。");
    }
    const counts = period.platforms.map((item) => item.runs.valid_runs);
    if (counts.length > 1 && Math.max(...counts) > 0 &&
      (Math.min(...counts) === 0 || Math.max(...counts) / Math.min(...counts) > 2)) {
      warnings.push("阶段“" + period.label + "”的平台有效样本量差异超过 2 倍，平台对比以比例和来源结构为主。");
    }
  }
  return warnings;
}

function reportSummary(payload, hash) {
  return {
    report_id: payload.report_id,
    task_id: payload.task_id,
    status: "ready",
    format: "html",
    title: payload.title,
    generated_at: payload.generated_at,
    platforms: payload.scope.platforms,
    periods: payload.scope.periods,
    profile_version: payload.profile.version,
    content_hash: hash,
    report_url: "/v1/geo-reports/" + payload.report_id,
    html_url: "/v1/geo-reports/" + payload.report_id + "/html",
  };
}

async function buildPayload(client, { tenantId, taskPublicId, input, createdAt }) {
  const task = await taskAndProject(client, tenantId, taskPublicId);
  const taskPlatforms = Array.isArray(task.platforms) ? task.platforms : JSON.parse(task.platforms ?? "[]");
  const request = normalizeGeoCustomerReportRequest(input, taskPlatforms);
  const targetBrand = nullableText(task.task_brand) ?? nullableText(task.project_brand);
  const trackedArticles = await enabledTrackedArticles(client, Number(task.project_id));
  const periods = [];
  const batchesByPeriod = new Map();
  const assignedBatches = new Set();

  for (const periodInput of request.periods) {
    const candidates = await periodBatches(client, {
      tenantId,
      taskDbId: Number(task.id),
      platforms: request.platforms,
      period: periodInput,
    });
    const repeated = candidates.find((row) => assignedBatches.has(Number(row.batch_db_id)));
    if (repeated) {
      fail("periods must not include the same execution batch more than once", 422, "overlapping_report_periods");
    }
    for (const candidate of candidates) assignedBatches.add(Number(candidate.batch_db_id));
    batchesByPeriod.set(periodInput.key, candidates);
    const included = candidates.filter((row) => TERMINAL_BATCH_STATUSES.has(row.status));
    const excluded = candidates.filter((row) => !TERMINAL_BATCH_STATUSES.has(row.status));
    const period = {
      key: periodInput.key,
      label: periodInput.label,
      from: periodInput.from,
      to: periodInput.to,
      time_zone: periodInput.time_zone,
      platforms: [],
      source_batches: [],
      excluded_batches: excluded.map((row) => ({
        execution_id: row.execution_id,
        platform: row.platform,
        status: row.status,
        started_at: publicDate(row.started_at),
      })),
    };

    for (const platformId of request.platforms) {
      const platformBatches = included.filter((row) => row.platform === platformId);
      const metrics = await platformMetrics(client, {
        batchRows: platformBatches,
        projectId: Number(task.project_id),
        brandConfigured: Boolean(targetBrand),
        trackedArticles,
      });
      period.platforms.push({
        platform: platformId,
        color: PLATFORM_COLORS[request.platforms.indexOf(platformId) % PLATFORM_COLORS.length],
        runs: metrics.runs,
        citations: metrics.citations,
        questions: metrics.questions,
      });
      period.source_batches.push(...platformBatches.map((row) => ({
        execution_id: row.execution_id,
        platform: row.platform,
        status: row.status,
        started_at: publicDate(row.started_at),
        finished_at: publicDate(row.finished_at),
      })));
    }
    periods.push(period);
  }

  comparePeriods(periods, request.platforms);
  return {
    request,
    batchesByPeriod,
    payload: {
      report_id: null,
      task_id: task.public_id,
      schema_version: REPORT_SCHEMA_VERSION,
      title: task.project_name + " GEO 收录效果报告",
      generated_at: createdAt,
      target: {
        name: task.project_name,
        task_name: task.task_name,
        brand: targetBrand,
        brand_configured: Boolean(targetBrand),
        tracked_articles_configured: trackedArticles.count > 0,
        tracked_articles_count: trackedArticles.count,
        tracked_articles: trackedArticles.articles,
      },
      profile: {
        id: "geo-customer-default",
        version: REPORT_PROFILE_VERSION,
        platform_colors: Object.fromEntries(request.platforms.map((platform, index) => [
          platform,
          PLATFORM_COLORS[index % PLATFORM_COLORS.length],
        ])),
      },
      scope: {
        platforms: request.platforms,
        periods: request.periods.map(({ key, label, from, to, time_zone }) => ({ key, label, from, to, time_zone })),
      },
      periods,
      methodology: {
        assignments: "sampling_batch_prompts 中的阶段内平台分配数；未执行的分配仍保留在分母。",
        valid_runs: "runs.status 为 success 或 partial，且 conversation_reset_confirmed 为 true。",
        citation_valid_runs: "runs.status 为 success，conversation_reset_confirmed 为 true，且 citation_state 为 found 或 none_visible。",
        visible_citations: "仅统计 source_type 为 visible 且 visible_to_user 为 true 的引用。",
        content_sources: "从内容来源排行排除 cdn.sm.cn 与 gw.alicdn.com 图标域；图标引用单独计数。",
      tracked_articles: "优先使用 citations.tracked_article_id；为空时按项目内 canonical_url 精确匹配。",
      tracked_article_comparison: "所有阶段使用生成报告时项目内当前启用的 tracked_articles 配置集合。",
        attribution: "引用与品牌提及的共现仅表示同一回答中同时观测到，不表示因果关系。",
        report_batch_scope: "按批次 started_at 落入指定本地日期范围筛选；仅纳入已结束批次。",
      },
      warnings: reportWarnings(periods, trackedArticles),
    },
  };
}

async function persistSnapshot(client, { tenantId, taskPublicId, request, batchesByPeriod, payload }) {
  const reportPublicId = newPublicId("rpt");
  payload.report_id = reportPublicId;
  const html = buildGeoCustomerReportHtml(payload);
  const artifactHash = sha256(html);
  const reportResult = await client.query(
    "INSERT INTO service_geo_reports (public_id, tenant_id, task_id, profile_version, request) " +
      "SELECT $1, $2, t.id, $4, $5::jsonb FROM service_tasks t " +
      "WHERE t.tenant_id = $2 AND t.public_id = $3 RETURNING id, created_at",
    [reportPublicId, tenantId, taskPublicId, REPORT_PROFILE_VERSION, JSON.stringify(request)],
  );
  const reportRow = reportResult.rows[0];
  if (!reportRow) fail("task was not found", 404, "task_not_found");

  for (const period of payload.periods) {
    await client.query(
      "INSERT INTO service_geo_report_periods (report_id, period_key, label, date_from, date_to, time_zone) " +
        "VALUES ($1, $2, $3, $4::date, $5::date, $6)",
      [reportRow.id, period.key, period.label, period.from, period.to, period.time_zone],
    );
    const candidates = batchesByPeriod.get(period.key) ?? [];
    const includedIds = new Set(period.source_batches.map((row) => row.execution_id));
    if (candidates.length) {
      const manifest = candidates.map((batch) => ({
        batch_id: Number(batch.batch_db_id),
        execution_id: batch.execution_id,
        platform: batch.platform,
        status: batch.status,
        started_at: batch.started_at,
        finished_at: batch.finished_at,
        included: includedIds.has(batch.execution_id),
      }));
      await client.query(
        "INSERT INTO service_geo_report_batches " +
          "(report_id, period_key, batch_id, execution_public_id, platform, status_snapshot, " +
          "started_at_snapshot, finished_at_snapshot, included) " +
          "SELECT $1, $2, source.batch_id, source.execution_id, source.platform, source.status, " +
          "source.started_at, source.finished_at, source.included " +
          "FROM jsonb_to_recordset($3::jsonb) AS source(" +
          "batch_id bigint, execution_id text, platform text, status text, " +
          "started_at timestamptz, finished_at timestamptz, included boolean)",
        [reportRow.id, period.key, JSON.stringify(manifest)],
      );
    }
  }

  const hash = contentHash(payload);
  await client.query(
    "INSERT INTO service_geo_report_revisions " +
      "(public_id, tenant_id, report_id, revision, schema_version, profile_version, content_hash, artifact_hash, payload, artifact_html) " +
      "VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8::jsonb, $9)",
    [newPublicId("rrev"), tenantId, reportRow.id, REPORT_SCHEMA_VERSION, REPORT_PROFILE_VERSION,
      hash, artifactHash, JSON.stringify(payload), html],
  );
  return { payload, content_hash: hash, artifact_hash: artifactHash, created_at: reportRow.created_at };
}

export async function createGeoCustomerReport(pool, { tenantId, taskPublicId, input }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const built = await buildPayload(client, {
      tenantId,
      taskPublicId,
      input,
      createdAt: new Date().toISOString(),
    });
    const saved = await persistSnapshot(client, {
      tenantId,
      taskPublicId,
      request: built.request,
      batchesByPeriod: built.batchesByPeriod,
      payload: built.payload,
    });
    await client.query("COMMIT");
    return reportSummary(saved.payload, saved.content_hash);
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    client.release();
  }
}

function decodeCursor(raw) {
  if (!raw) return null;
  try {
    const value = JSON.parse(Buffer.from(String(raw), "base64url").toString("utf8"));
    if (value?.v !== 1 || value?.k !== "geo-reports" || !Number.isInteger(value?.id) || value.id < 1) {
      throw new Error("bad cursor");
    }
    return value.id;
  } catch {
    fail("cursor is invalid for this collection", 400, "invalid_cursor");
  }
}

function encodeCursor(id) {
  return Buffer.from(JSON.stringify({ v: 1, k: "geo-reports", id: Number(id) }), "utf8").toString("base64url");
}

function assertSnapshotIntegrity(payload, hash) {
  if (!payload || contentHash(payload) !== hash) {
    throw new ApiHttpError(500, "report_snapshot_integrity_error", "stored GEO report snapshot failed its content hash check");
  }
}

export async function getGeoCustomerReport(pool, { tenantId, reportPublicId }) {
  const { rows } = await pool.query(
    "SELECT r.id, r.public_id, t.public_id AS task_public_id, r.created_at, rev.payload, rev.content_hash " +
      "FROM service_geo_reports r JOIN service_tasks t ON t.id = r.task_id " +
      "JOIN LATERAL (SELECT payload, content_hash FROM service_geo_report_revisions " +
      "WHERE report_id = r.id AND tenant_id = $1 ORDER BY revision DESC LIMIT 1) rev ON TRUE " +
      "WHERE r.tenant_id = $1 AND r.public_id = $2",
    [tenantId, reportPublicId],
  );
  const row = rows[0];
  if (!row) return null;
  assertSnapshotIntegrity(row.payload, row.content_hash);
  return { ...reportSummary(row.payload, row.content_hash), snapshot: row.payload };
}

export async function getGeoCustomerReportHtml(pool, { tenantId, reportPublicId }) {
  const { rows } = await pool.query(
    "SELECT rev.payload, rev.content_hash, rev.artifact_html, rev.artifact_hash " +
      "FROM service_geo_reports r JOIN LATERAL (" +
      "SELECT payload, content_hash, artifact_html, artifact_hash FROM service_geo_report_revisions " +
      "WHERE report_id = r.id AND tenant_id = $1 ORDER BY revision DESC LIMIT 1" +
      ") rev ON TRUE WHERE r.tenant_id = $1 AND r.public_id = $2",
    [tenantId, reportPublicId],
  );
  const row = rows[0];
  if (!row) return null;
  assertSnapshotIntegrity(row.payload, row.content_hash);
  if (sha256(row.artifact_html) !== row.artifact_hash) {
    throw new ApiHttpError(500, "report_artifact_integrity_error", "stored GEO report HTML failed its content hash check");
  }
  return { html: row.artifact_html, content_hash: row.content_hash, artifact_hash: row.artifact_hash };
}

export async function listGeoCustomerReports(pool, { tenantId, taskPublicId, limit = 100, cursor = null }) {
  const boundedLimit = Number(limit);
  if (!Number.isInteger(boundedLimit) || boundedLimit < 1 || boundedLimit > HISTORY_MAX_LIMIT) {
    fail("limit must be an integer between 1 and " + HISTORY_MAX_LIMIT);
  }
  const task = await taskAndProject(pool, tenantId, taskPublicId);
  const beforeId = decodeCursor(cursor);
  const { rows } = await pool.query(
    "SELECT r.id, rev.payload, rev.content_hash FROM service_geo_reports r " +
      "JOIN LATERAL (SELECT payload, content_hash FROM service_geo_report_revisions " +
      "WHERE report_id = r.id AND tenant_id = $1 ORDER BY revision DESC LIMIT 1) rev ON TRUE " +
      "WHERE r.tenant_id = $1 AND r.task_id = $2 AND ($3::bigint IS NULL OR r.id < $3) " +
      "ORDER BY r.id DESC LIMIT $4",
    [tenantId, task.id, beforeId, boundedLimit + 1],
  );
  const hasMore = rows.length > boundedLimit;
  const visible = rows.slice(0, boundedLimit);
  const data = visible.map((row) => {
    assertSnapshotIntegrity(row.payload, row.content_hash);
    return reportSummary(row.payload, row.content_hash);
  });
  return {
    data,
    meta: {
      has_more: hasMore,
      next_cursor: hasMore && visible.length ? encodeCursor(visible[visible.length - 1].id) : null,
    },
  };
}
