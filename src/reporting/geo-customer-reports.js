import crypto from "node:crypto";

import { ApiHttpError } from "../api/http.js";
import { supportedProviderIds } from "../providers/index.js";
import { buildGeoCustomerReportHtml } from "../report/html-geo-customer.js";
import { BrandInputError, computeBrandMentions, normalizeBrands } from "../analysis/brand-mentions.js";
import { resolveReportScope } from "../tasks/groups.js";
import { CITATION_EVIDENCE_STATES, citationValidRunSql } from "../db/citation-validity.js";

/**
 * 引用状态白名单转成 SQL IN 列表。
 *
 * 取值来自 citation-validity.js 而不是就地写死：各平台 citation_state 词表不同
 * （千问用 'ok'，豆包用 'found'），就地写死会让非豆包平台的引用数静默变成 0。
 */
const CITATION_STATE_LIST = CITATION_EVIDENCE_STATES.map((state) => `'${state}'`).join(", ");

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
  onlyKeys(input, ["platforms", "periods", "format", "brands"], "request body");
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
  // 品牌列表由调用方在报告请求里给，不预设、不维护。
  // OneGl 只做匹配统计 —— 「哪个是真机构」「怎么排序」由调用方的模型先判断。
  let brands;
  try {
    brands = normalizeBrands(input.brands);
  } catch (error) {
    if (error instanceof BrandInputError) fail(error.message, 422, "invalid_brands");
    throw error;
  }
  return { platforms, periods, format: "html", brands };
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

/**
 * 组内全部 project 的目标内容合集。
 *
 * 去重按 canonical_url：跨平台任务下同一篇目标文章常在多个 project 下各配一份，
 * 直接 UNION ALL 会让 configured_count 随 project 数翻倍，覆盖率分母失真。
 */
async function enabledTrackedArticles(client, projectIds) {
  const { rows } = await client.query(
    "SELECT canonical_url, max(title) AS title, max(normalized_domain) AS domain, count(*) OVER() AS configured_count " +
      "FROM tracked_articles " +
      " WHERE project_id = ANY($1::bigint[]) AND enabled IS TRUE " +
      " GROUP BY canonical_url " +
      " ORDER BY canonical_url LIMIT 500",
    [projectIds],
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

/**
 * 一个时间窗口内、属于指定任务集合的已结束批次。
 *
 * taskIds 是数组而不是单个 id：一个 GEO 任务可以横跨多个采集任务（每个平台一个），
 * 报告要按平台横排就必须一次取全。传单元素数组即可保持原有单任务语义。
 */
async function periodBatches(client, { tenantId, taskIds, platforms, period }) {
  const { rows } = await client.query(
    "SELECT e.public_id AS execution_id, b.id AS batch_db_id, b.provider AS platform, " +
      "b.status, b.started_at, b.finished_at, b.requested_jobs, b.completed_jobs, b.failed_jobs, b.skipped_jobs " +
      "FROM service_task_executions e JOIN sampling_batches b ON b.id = e.batch_id " +
      "WHERE e.tenant_id = $1 AND e.task_id = ANY($2::bigint[]) AND b.provider = ANY($3::text[]) " +
      "AND b.started_at >= ($4::date::timestamp AT TIME ZONE $6) " +
      "AND b.started_at < (($5::date + 1)::timestamp AT TIME ZONE $6) " +
      "ORDER BY b.started_at, e.public_id",
    [tenantId, taskIds, platforms, period.from, period.to, period.time_zone],
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
          `AND citation_state IN (${CITATION_STATE_LIST})) AS citation_valid_runs, ` +
        "count(*) FILTER (WHERE status = 'partial') AS partial_runs, " +
        "count(*) FILTER (WHERE status = 'failed') AS failed_runs, " +
        "count(*) FILTER (WHERE status IN ('success', 'partial') AND conversation_reset_confirmed IS NOT TRUE) AS reset_unconfirmed_runs, " +
        "count(*) FILTER (WHERE status IN ('success', 'partial') AND conversation_reset_confirmed IS TRUE " +
          "AND answer IS NOT NULL AND btrim(answer) <> '' " +
          // 排除平台自己没写完的回答：answer_truncated 是标点启发式（结尾不是句末标点），
          // answer_completion='timeout' 是被预算掐断的确定性证据。
          // 早期版本两者都没排除，于是「平均回答长度」把半句话当完整回答算进均值，
          // 「answers_with_text」也把不可信产出计入 —— 数字看起来正常，无从察觉。
          "AND COALESCE(answer_truncated, false) IS NOT TRUE " +
          "AND COALESCE(answer_completion, 'follow-up-chips') NOT IN ('timeout', 'length-stability-fallback')" +
          ") AS answers_with_text, " +
        "avg(char_length(answer)) FILTER (WHERE status IN ('success', 'partial') " +
          "AND conversation_reset_confirmed IS TRUE AND answer IS NOT NULL AND btrim(answer) <> '' " +
          "AND COALESCE(answer_truncated, false) IS NOT TRUE " +
          "AND COALESCE(answer_completion, 'follow-up-chips') NOT IN ('timeout', 'length-stability-fallback')" +
          ") AS average_answer_characters, " +
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

/**
 * 引用来源的公共 CTE。
 *
 * $2 是 project_id **数组**而不是单个值：一个 GEO 任务可以横跨多个采集任务，
 * 每个平台一个 project，目标内容（tracked_articles）按 project 配置。
 * 跨平台报告要横排，就必须在同一批引用上匹配全部相关 project 的目标内容，
 * 否则各平台算出来的覆盖率分母不是同一套东西，横排就没有可比性。
 */
function citationSourceSql() {
  return "WITH source_rows AS (" +
    " SELECT c.id AS citation_id, c.run_id, a.id AS article_id, a.canonical_url, a.title, " +
    "        a.normalized_domain AS domain, " +
    "        CASE WHEN EXISTS (SELECT 1 FROM unnest($3::text[]) AS icon_domain(value) " +
    "          WHERE lower(COALESCE(a.normalized_domain, '')) = icon_domain.value " +
    "             OR lower(COALESCE(a.normalized_domain, '')) LIKE '%.' || icon_domain.value) " +
    "        THEN TRUE ELSE FALSE END AS is_icon, " +
    "        (SELECT t.id FROM tracked_articles t WHERE t.project_id = ANY($2::bigint[]) AND t.enabled IS TRUE " +
    "          AND (t.id = c.tracked_article_id OR (c.tracked_article_id IS NULL AND t.canonical_url = a.canonical_url)) " +
    "          ORDER BY (t.id = c.tracked_article_id) DESC LIMIT 1) AS tracked_article_id " +
    " FROM citations c JOIN runs r ON r.id = c.run_id JOIN articles a ON a.id = c.article_id " +
    " WHERE r.sampling_batch_id = ANY($1::bigint[]) AND r.status = 'success' " +
    `   AND r.conversation_reset_confirmed IS TRUE AND r.citation_state IN (${CITATION_STATE_LIST}) ` +
    "   AND c.source_type = 'visible' AND c.visible_to_user IS TRUE)";
}

async function queryCitationMetrics(client, batchIds, projectIds, citationValidRuns, trackedCount) {
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
      [batchIds, projectIds, ICON_DOMAINS],
    ),
    client.query(
      sourceSql + " SELECT domain, count(*) AS citations, count(DISTINCT article_id) AS articles, " +
        "count(DISTINCT run_id) AS covered_runs FROM source_rows " +
        "WHERE is_icon IS FALSE AND domain IS NOT NULL AND domain <> '' " +
        "GROUP BY domain ORDER BY covered_runs DESC, citations DESC, domain LIMIT 12",
      [batchIds, projectIds, ICON_DOMAINS],
    ),
    client.query(
      sourceSql + " SELECT canonical_url, title, domain, count(*) AS citations, " +
        "count(DISTINCT run_id) AS covered_runs FROM source_rows WHERE is_icon IS FALSE " +
        "GROUP BY canonical_url, title, domain " +
        "ORDER BY covered_runs DESC, citations DESC, canonical_url LIMIT 12",
      [batchIds, projectIds, ICON_DOMAINS],
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

/**
 * 目标内容（tracked_articles）的逐条明细。
 *
 * $1 是 project_id 数组：跨平台任务下每个平台一个 project，目标是「这个品牌在各平台
 * 都被引用的内容」，所以要把组内全部 project 的配置合起来看，平台维度在外层再拆。
 * 去重按 canonical_url —— 同一篇文章常被配到多个 project 下，
 * 不去重会让 configured_count 虚高、覆盖率分母失真。
 */
async function queryTrackedArticleDetails(client, batchIds, projectIds) {
  const { rows } = await client.query(
    "SELECT t.canonical_url, max(t.title) AS title, max(t.normalized_domain) AS domain, " +
      "count(c.citation_id) AS citations, count(DISTINCT c.run_id) AS covered_runs, " +
      "count(*) OVER() AS configured_count " +
      "FROM (SELECT DISTINCT ON (canonical_url) id, canonical_url, title, normalized_domain, project_id " +
      "        FROM tracked_articles " +
      "       WHERE project_id = ANY($1::bigint[]) AND enabled IS TRUE " +
      "       ORDER BY canonical_url, id) t " +
      "LEFT JOIN LATERAL (" +
      " SELECT c.id AS citation_id, r.id AS run_id FROM articles a " +
      " JOIN citations c ON c.article_id = a.id " +
      " JOIN runs r ON r.id = c.run_id " +
      " WHERE (c.tracked_article_id = t.id OR (c.tracked_article_id IS NULL AND a.canonical_url = t.canonical_url)) " +
      "   AND r.sampling_batch_id = ANY($2::bigint[]) AND r.status = 'success' " +
      `   AND r.conversation_reset_confirmed IS TRUE AND r.citation_state IN (${CITATION_STATE_LIST}) ` +
      "   AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY['cdn.sm.cn', 'gw.alicdn.com']::text[]) AS icon_domain(value) " +
      "     WHERE lower(COALESCE(a.normalized_domain, '')) = icon_domain.value " +
      "        OR lower(COALESCE(a.normalized_domain, '')) LIKE '%.' || icon_domain.value) " +
      "   AND c.source_type = 'visible' AND c.visible_to_user IS TRUE" +
      ") c ON TRUE " +
      "GROUP BY t.canonical_url ORDER BY covered_runs DESC, citations DESC, t.canonical_url LIMIT 200",
    [projectIds, batchIds],
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

/**
 * 该平台在这批批次里的 AI 回答正文。
 *
 * 报告要能回答「AI 到底推荐了什么」而不是只给聚合数字，就必须把原文带出来。
 * 但全量带出会让快照体积失控（实测 122 篇约 11.5 万字符 ≈ 35 万 token），
 * 所以这里只带**排名候选的出处**：每个候选若干条原文片段 + run_id，
 * 完整正文由调用方按 run_id 单独拉取。
 *
 * 口径与引用统计一致：只用成功且确认新会话的回答，失败行的残缺文本不算 AI 的判断。
 */
async function queryAnswerExcerpts(client, batchIds, { limit = 400 } = {}) {
  if (!batchIds.length) return [];
  const { rows } = await client.query(
    "SELECT r.local_run_id, r.answer, length(r.answer) AS answer_chars, " +
      "  p.prompt AS question " +
      "FROM runs r JOIN prompts p ON p.id = r.prompt_id " +
      "WHERE r.sampling_batch_id = ANY($1::bigint[]) " +
      "  AND r.status = 'success' AND r.conversation_reset_confirmed IS TRUE " +
      "  AND length(COALESCE(r.answer, '')) > 0 " +
      "ORDER BY r.id LIMIT $2",
    [batchIds, limit],
  );
  return rows.map((row) => ({
    run_id: row.local_run_id,
    question: row.question,
    answer_chars: asNumber(row.answer_chars),
  }));
}

/**
 * 「这条回答是不是 AI 完整说完了」——品牌提及统计只认完整回答。
 *
 * 三处口径必须完全一致（报告概览、平均长度、提及率分母），抽成常量
 * 就是为了避免只改一处：早期版本这里判空、别处判截断，结果是
 * 「有 122 条回答」但「只有 97 条可信」，两个数字在同一份 payload 里对不上。
 *
 * answer_completion 为 NULL 表示旧行/平台未上报，按可信处理（COALESCE 到
 * follow-up-chips）—— 与 citation-validity.js 的处理方式一致：
 * 缺数据不等于不可信。
 */
const UNTRUSTED_COMPLETION_SQL =
  "COALESCE(r.answer_truncated, false) IS NOT TRUE " +
  "AND COALESCE(r.answer_completion, 'follow-up-chips') NOT IN ('timeout', 'length-stability-fallback')";

/** 排名所需的完整回答正文。只在生成排名时读，不进快照。 */
async function queryAnswersForRanking(client, batchIds, { limit = 2000 } = {}) {
  if (!batchIds.length) return { answers: [], eligible: 0, excluded: 0, truncatedByLimit: false };
  // 一次查两件事：过完整口径的正文（喂匹配），以及「有正文但被口径排除」的计数。
  // 第二个数字是分母可审计的关键 —— 只报 answer_count 的话，调用方无从判断
  // 分母小是因为平台没回答，还是我们主动剔掉了不可信样本。
  const { rows } = await client.query(
    `SELECT r.local_run_id AS run_id, r.provider, r.answer AS text,
            (length(COALESCE(r.answer, '')) > 0
             AND COALESCE(${UNTRUSTED_COMPLETION_SQL})) AS usable
       FROM runs r
      WHERE r.sampling_batch_id = ANY($1::bigint[])
        AND r.status = 'success' AND r.conversation_reset_confirmed IS TRUE
        AND length(COALESCE(r.answer, '')) > 0
      ORDER BY r.id`,
    [batchIds],
  );
  const eligible = rows.filter((row) => row.usable).slice(0, limit);
  return {
    answers: eligible.map((row) => ({ runId: row.run_id, provider: row.provider, text: row.text })),
    eligible: eligible.length,
    // 有正文但被口径排除的条数
    excluded: rows.length - eligible.length,
    // 触到 limit 上限：分母被截断，必须如实上报
    truncatedByLimit: rows.filter((row) => row.usable).length > limit,
  };
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

async function platformMetrics(client, { batchRows, projectIds, brandConfigured, trackedArticles, brands = [] }) {
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
      answers: [],
      brand_mentions: emptyBrandMentions(brands),
      source_batches: [],
    };
  }

  const runs = await queryRunMetrics(client, batchIds, brandConfigured);
  const citations = await queryCitationMetrics(client, batchIds, projectIds, runs.citation_valid_runs, trackedArticles.count);
  const [trackedDetails, questions, answers] = await Promise.all([
    queryTrackedArticleDetails(client, batchIds, projectIds),
    queryQuestions(client, batchIds),
    queryAnswerExcerpts(client, batchIds),
  ]);
  citations.tracked_content.configured = trackedDetails.configured_count > 0;
  citations.tracked_content.configured_articles = trackedDetails.configured_count;
  citations.tracked_content.articles = runs.citation_valid_runs > 0
    ? trackedDetails.articles
    : trackedDetails.articles.map((article) => ({ ...article, citations: null, covered_runs: null }));
  citations.tracked_content.truncated = trackedDetails.truncated;

  // 回答正文读一次，算完即弃 —— 快照里只留统计结果和出处，不留全文。
  // 正文按 run_id 单独取（见 GET /v1/answers），避免快照体积失控。
  const ranking = await queryAnswersForRanking(client, batchIds);
  const brandMentions = computeBrandMentions(ranking.answers, brands);
  // excluded_answers 报 SQL 层真正排除的条数（过短 / 被平台截断 / 空白）。
  // 必须如实上报：只给 answer_count 的话，调用方无法判断分母小是因为
  // 平台没回答，还是我们主动剔掉了不可信样本 —— 两种情况含义完全不同。
  brandMentions.excluded_answers = ranking.excluded;
  if (ranking.truncatedByLimit) {
    brandMentions.truncated = true;
    brandMentions.notes = [
      ...(brandMentions.notes ?? []),
      `回答数超过单次统计上限，仅用最早的 ${ranking.answers.length} 条计算提及率；` +
        "分母偏小，请缩小 period 范围后重新生成。",
    ];
  }
  return {
    runs,
    citations,
    questions,
    answers,
    // 品牌提及：调用方在 brands 里给了哪些品牌就统计哪些，没给就是空结果而不是猜测。
    // 品牌列表怎么来 —— 调用方按平台分层抽样 1/10，把回答丢给自己的模型读一遍，
    // 拿到高频品牌再用 brands 传回。OneGl 不猜机构名，也不需要维护品牌库。
    brand_mentions: brandMentions,
  };
}

function emptyBrandMentions(brands) {
  return {
    schema: "brand-mentions.v1",
    // available=false 表示「这次根本没做品牌统计」（没传 brands 或没有可用回答），
    // 与 available=true 但某品牌 mention_rate=0（「统计了，确实没提到」）是两件事。
    // 对比端点靠这个字段区分，否则会把「没测」报成「下降到 0」。
    available: brands.length > 0,
    answer_count: 0,
    excluded_answers: 0,
    truncated: false,
    notes: [],
    brand_count: 0,
    basis: "mentioned_answers_over_valid_answers",
    brands: [],
    interpretation: {
      provided_by: "onegl",
      role: "mention_statistics",
      conclusion: null,
      guidance: brands.length
        ? "当前范围没有可分析的回答正文。"
        : "未传 brands 参数，不做品牌提及统计。品牌列表可先用 GET /v1/answers?sample_ratio=0.1 抽样、" +
          "交给你的模型读回答得到高频品牌，再随报告请求的 brands 传回。",
    },
  };
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
    // task_id 与 group_id 恰好一个非空：单采集任务报告 vs 跨平台任务组报告。
    task_id: payload.task_id ?? null,
    group_id: payload.group_id ?? null,
    scope_kind: payload.scope_kind ?? "task",
    status: "ready",
    format: "html",
    title: payload.title,
    generated_at: payload.generated_at,
    platforms: payload.scope.platforms,
    periods: payload.scope.periods,
    // 传了 brands 才统计；没传就是空数组，调用方据此知道没做品牌分析。
    brands: payload.scope?.brands ?? [],
    // 每个平台的品牌提及统计直接提上来，省得调用方去翻 snapshot。
    // 结论仍然是空的：解读由调用方的模型做。
    brand_mentions: (payload.periods ?? []).flatMap((period) =>
      (period.platforms ?? []).map((platform) => ({
        period_key: period.key,
        platform: platform.platform,
        answer_count: platform.brand_mentions?.answer_count ?? 0,
        // 分母被排除了多少条（空白、过短的平台 UI 文案、被截断的回答）。
        // 必须一起给出：只报 answer_count 的话，调用方无法判断
        // 「分母小」是因为平台没回答，还是因为我们把不可信的剔掉了。
        excluded_answers: platform.brand_mentions?.excluded_answers ?? 0,
        brands: platform.brand_mentions?.brands ?? [],
      })),
    ),
    profile_version: payload.profile.version,
    content_hash: hash,
    report_url: "/v1/geo-reports/" + payload.report_id,
    html_url: "/v1/geo-reports/" + payload.report_id + "/html",
  };
}

/**
 * 组装报告快照。
 *
 * scope 由 resolveReportScope 给出，既可能是单个 task，也可能是任务组
 * （一个用户任务横跨多个平台、每个平台一个采集 task）。组的情况下 taskIds 和
 * projectIds 都是多元素，periodBatches / tracked_articles 都按集合处理，
 * 平台维度在 period.platforms 里逐个展开 —— 这正是跨平台横排的来源。
 */
async function buildPayload(client, { tenantId, scope, input, createdAt }) {
  const taskPlatforms = scope.platforms;
  const request = normalizeGeoCustomerReportRequest(input, taskPlatforms);
  // 品牌只能来自采集时配置的 scope，不接受报告阶段传入。
  //
  // 曾经支持请求体传 brand，但那是假的：brand_mention_rate 读的是采集时落库的
  // runs.brand_mentioned / matched_terms，报告阶段传名字不会触发重新检测 ——
  // 传「思邈棠」和传一个从未检测过的词，拿到的提及率完全一样。接口会显示调用方
  // 想要的名字，配一个与该名字无关的数字，看起来完全正常却全错。
  //
  // 要换品牌必须改采集侧的项目/任务配置并重新采集。宁可指标不可用，也不给假数字。
  const targetBrand = nullableText(scope.brand);
  const projectIds = scope.projects.map((item) => item.project_id);
  const trackedArticles = await enabledTrackedArticles(client, projectIds);
  const periods = [];
  const batchesByPeriod = new Map();
  const assignedBatches = new Set();

  for (const periodInput of request.periods) {
    const candidates = await periodBatches(client, {
      tenantId,
      taskIds: scope.taskIds,
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
        projectIds,
        brandConfigured: Boolean(targetBrand),
        trackedArticles,
        brands: request.brands,
      });
      period.platforms.push({
        platform: platformId,
        color: PLATFORM_COLORS[request.platforms.indexOf(platformId) % PLATFORM_COLORS.length],
        runs: metrics.runs,
        citations: metrics.citations,
        questions: metrics.questions,
        // AI 回答的元信息（不含正文）+ 品牌提及统计。
        // 正文按 run_id 从 GET /v1/answers 取，避免快照体积失控。
        answers: metrics.answers,
        brand_mentions: metrics.brand_mentions,
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
      // task_id 保留给单任务报告；跨平台任务用 group_id 表达，
      // 两个字段同时存在，调用方据 scope_kind 判断该用哪个。
      task_id: scope.kind === "task" ? scope.public_id : null,
      group_id: scope.kind === "group" ? scope.public_id : null,
      scope_kind: scope.kind,
      schema_version: REPORT_SCHEMA_VERSION,
      title: scope.name + " GEO 收录效果报告",
      generated_at: createdAt,
      target: {
        // 跨平台任务下不止一个 project，name 用任务组名，
        // projects 保留全部成员项目，调用方需要时可自行区分。
        name: scope.name,
        task_name: scope.kind === "task" ? scope.name : scope.tasks.map((t) => t.name).join(" / "),
        group_id: scope.kind === "group" ? scope.public_id : null,
        projects: scope.projects,
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
        // 原样回显调用方传入的品牌，便于核对「这份报告统计的是哪些词」
        brands: request.brands.map((brand) => ({
          name: brand.name,
          role: brand.role,
          aliases: brand.aliases,
          product_aliases: brand.product_aliases,
        })),
      },
      periods,
      methodology: {
        assignments: "sampling_batch_prompts 中的阶段内平台分配数；未执行的分配仍保留在分母。",
        valid_runs: "runs.status 为 success 或 partial，且 conversation_reset_confirmed 为 true。",
        citation_valid_runs:
          "runs.status 为 success，conversation_reset_confirmed 为 true，且 citation_state 属于引用证据可信集合" +
          `（${CITATION_EVIDENCE_STATES.join("、")}）。各平台词表不同：豆包用 found、千问用 ok，语义都是「抓到引用且核对通过」。`,
        visible_citations: "仅统计 source_type 为 visible 且 visible_to_user 为 true 的引用。",
        content_sources: "从内容来源排行排除 cdn.sm.cn 与 gw.alicdn.com 图标域；图标引用单独计数。",
        tracked_articles: "优先使用 citations.tracked_article_id；为空时按项目内 canonical_url 精确匹配。",
        tracked_article_comparison: "所有阶段使用生成报告时项目内当前启用的 tracked_articles 配置集合。",
        brand_mentions:
          "品牌由报告请求的 brands 参数传入，OneGl 不预设品牌、不猜机构名、不维护品牌库。" +
          "匹配用品牌名 + 别名 + 产品名的子串匹配，分母是该平台有正文的回答数。" +
          "提及率是确定性统计，可复现可核对；「被提及」不等于「被推荐」，" +
          "推荐强度与投放策略需调用方用自己的模型分析。",
        answer_text:
          "回答正文不随报告快照下发。按 run_id 从 GET /v1/answers 单独取，" +
          "支持按平台分层抽样（sample_ratio），用于让模型从抽样样本中发现高频品牌。",
        attribution: "引用与品牌提及的共现仅表示同一回答中同时观测到，不表示因果关系。",
        report_batch_scope: "按批次 started_at 落入指定本地日期范围筛选；仅纳入已结束批次。",
      },
      warnings: reportWarnings(periods, trackedArticles),
    },
  };
}

async function persistSnapshot(client, { tenantId, scope, request, batchesByPeriod, payload }) {
  const reportPublicId = newPublicId("rpt");
  payload.report_id = reportPublicId;
  const html = buildGeoCustomerReportHtml(payload);
  const artifactHash = sha256(html);
  // 单任务写 task_id，组报告写 group_id；表上的 CHECK 保证恰好有一个非空。
  // 归属对象已在 buildPayload 里校验过租户，这里只按 id 落库。
  const reportResult = await client.query(
    "INSERT INTO service_geo_reports (public_id, tenant_id, task_id, group_id, profile_version, request) " +
      "VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id, created_at",
    [
      reportPublicId,
      tenantId,
      scope.kind === "task" ? scope.id : null,
      scope.kind === "group" ? scope.id : null,
      REPORT_PROFILE_VERSION,
      JSON.stringify(request),
    ],
  );
  const reportRow = reportResult.rows[0];
  if (!reportRow) fail("report scope was not found", 404, "scope_not_found");

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

/**
 * 生成一份 GEO 客户报告。
 *
 * scope 来自 resolveReportScope：传 taskId 得到单任务报告，传 groupId 得到
 * 跨平台报告（组内多个采集任务的平台横排在一张表里）。两者共用同一套快照与
 * 修订机制，区别只在 payload.scope_kind 与聚合范围。
 */
export async function createGeoCustomerReport(pool, { tenantId, taskId = null, groupId = null, input }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const scope = await resolveReportScope(client, { tenantId, taskId, groupId });
    const built = await buildPayload(client, {
      tenantId,
      scope,
      input,
      createdAt: new Date().toISOString(),
    });
    const saved = await persistSnapshot(client, {
      tenantId,
      scope,
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

/**
 * 取某个范围（任务组或单任务）下最新的一份报告。
 *
 * 「选甲任务和乙任务对比」这个用法里，调用方手上是两个任务/任务组，
 * 而不是两个 report_id —— report_id 是生成报告时才产生的。让调用方先查历史、
 * 再从列表里挑 id、手工配对，是把 OneGl 内部的 ID 泄漏成了调用方的负担，
 * 而且很容易挑错（挑到别的任务组的报告）。
 *
 * 入参是 public_id（grp_…/tsk_…），与对外契约一致；先解析成内部主键再查，
 * 不能拿 public_id 直接去比内部 bigint 列。
 */
export async function getLatestGeoCustomerReport(pool, { tenantId, taskId = null, groupId = null }) {
  if (!taskId && !groupId) fail("task_id or group_id is required");
  // public_id → 内部主键。与对外契约一致的是 public_id，
  // 而 reports 表存的是内部 bigint，两者不能直接比较。
  const { rows: scope } = await pool.query(
    `SELECT
       (SELECT id FROM service_tasks      WHERE tenant_id = $1 AND public_id = $2) AS task_db_id,
       (SELECT id FROM service_task_groups WHERE tenant_id = $1 AND public_id = $3) AS group_db_id`,
    [tenantId, taskId, groupId],
  );
  const taskDbId = scope[0]?.task_db_id ?? null;
  const groupDbId = scope[0]?.group_db_id ?? null;
  if (!taskDbId && !groupDbId) return null;

  const { rows } = await pool.query(
    `SELECT r.public_id
       FROM service_geo_reports r
      WHERE r.tenant_id = $1
        AND (($2::bigint IS NOT NULL AND r.task_id = $2)
          OR ($3::bigint IS NOT NULL AND r.group_id = $3))
      ORDER BY r.id DESC
      LIMIT 1`,
    [tenantId, taskDbId, groupDbId],
  );
  return rows[0]?.public_id ?? null;
}

export async function getGeoCustomerReport(pool, { tenantId, reportPublicId }) {
  // task_id / group_id 必须都是 LEFT JOIN：跨平台报告的 task_id 是空的（归属在组上），
  // 用 INNER JOIN 会把整类组报告静默过滤掉，表现为「刚生成的报告立刻查不到」。
  const { rows } = await pool.query(
    "SELECT r.id, r.public_id, t.public_id AS task_public_id, g.public_id AS group_public_id, " +
      "r.created_at, rev.payload, rev.content_hash " +
      "FROM service_geo_reports r " +
      "LEFT JOIN service_tasks t ON t.id = r.task_id " +
      "LEFT JOIN service_task_groups g ON g.id = r.group_id " +
      "JOIN LATERAL (SELECT payload, content_hash FROM service_geo_report_revisions " +
      "WHERE report_id = r.id AND tenant_id = $1 ORDER BY revision DESC LIMIT 1) rev ON TRUE " +
      "WHERE r.tenant_id = $1 AND r.public_id = $2",
    [tenantId, reportPublicId],
  );
  const row = rows[0];
  if (!row) return null;
  assertSnapshotIntegrity(row.payload, row.content_hash);
  return {
    ...reportSummary(row.payload, row.content_hash),
    // 组报告没有 task_id，scope 身份从 group_id 推导，避免响应里出现两个 null。
    scope_kind: row.group_public_id ? "group" : "task",
    task_id: row.task_public_id ?? null,
    group_id: row.group_public_id ?? null,
    snapshot: row.payload,
  };
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

/**
 * 列出某个范围内的报告历史，GEO 侧据此挑「最近几份」做横向对比。
 *
 * scope 既可以是 task 也可以是 group：组口径下返回该组名下所有报告，
 * 这正是「基于最近报告对比」的数据来源。
 */
export async function listGeoCustomerReports(pool, { tenantId, taskId = null, groupId = null, limit = 100, cursor = null }) {
  const boundedLimit = Number(limit);
  if (!Number.isInteger(boundedLimit) || boundedLimit < 1 || boundedLimit > HISTORY_MAX_LIMIT) {
    fail("limit must be an integer between 1 and " + HISTORY_MAX_LIMIT);
  }
  const scope = await resolveReportScope(pool, { tenantId, taskId, groupId });
  const beforeId = decodeCursor(cursor);
  const { rows } = await pool.query(
    "SELECT r.id, rev.payload, rev.content_hash FROM service_geo_reports r " +
      "JOIN LATERAL (SELECT payload, content_hash FROM service_geo_report_revisions " +
      "WHERE report_id = r.id AND tenant_id = $1 ORDER BY revision DESC LIMIT 1) rev ON TRUE " +
      "WHERE r.tenant_id = $1 AND (($2::bigint IS NOT NULL AND r.task_id = $2) " +
      "  OR ($3::bigint IS NOT NULL AND r.group_id = $3)) " +
      "  AND ($4::bigint IS NULL OR r.id < $4) " +
      "ORDER BY r.id DESC LIMIT $5",
    [tenantId, scope.kind === "task" ? scope.id : null, scope.kind === "group" ? scope.id : null, beforeId, boundedLimit + 1],
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
      scope_kind: scope.kind,
      has_more: hasMore,
      next_cursor: hasMore && visible.length ? encodeCursor(visible[visible.length - 1].id) : null,
    },
  };
}
