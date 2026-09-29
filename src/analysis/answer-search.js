import { compileBrandRules, detectBrandMention } from "../brand/detect.js";
import { isUsableAnswerText, safeContext, MIN_USABLE_ANSWER_CHARS } from "./text-slice.js";

/**
 * 对话检索：让调用方从聚合数字追问到具体回答。
 *
 * ## 存在的理由
 *
 * 报告给的是「思邈棠提及率 66%」。调用方拿到这个数字后，agent 要回答的是
 * 「那 64 条具体是怎么说的」「它是被推荐还是被顺带提了一句」「排在什么位置」。
 * 没有检索端点，这些只能靠 agent 猜；而拿全量 11.5 万字符回答去读又太贵
 * （约 35 万 token，且大部分与问题无关）。
 *
 * 检索端点把中间地带补上：按关键词 / 按品牌命中，精准取回那几十条。
 *
 * ## 与已有能力的复用
 *
 * - 关键词检索走 0032 迁移建的 pg_trgm 索引（runs.search_text）
 * - 品牌命中走与 brand-mentions.js 完全相同的 compileBrandRules / detectBrandMention，
 *   保证「报告说 64 条」和「检索返回 64 条」口径一致 —— 两者若不一致，
 *   调用方会怀疑数据，进而不再信任整个报告
 */

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function fail(message, status = 400, code = "invalid_request") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  throw error;
}

function positiveInt(raw, name, fallback, max) {
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    fail(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

/** offset 允许 0（第一页），与 limit 的语义不同，不能复用 positiveInt。 */
function nonNegativeInt(raw, name, fallback, max) {
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > max) {
    fail(`${name} must be an integer between 0 and ${max}`);
  }
  return value;
}

/**
 * 品牌定义校验。与 brand-mentions.js 的 normalizeBrands 对齐，
 * 但这里更宽松：不强制 role（检索场景下「找一下思邈棠」不需要标竞品）。
 */
function parseBrand(spec, index) {
  const brand = typeof spec === "string" ? { name: spec } : spec;
  if (!brand || typeof brand !== "object" || Array.isArray(brand)) {
    fail(`brands[${index}] must be a string or an object`);
  }
  const name = String(brand.name ?? "").trim();
  if (!name) fail(`brands[${index}].name is required`);
  const list = (value) => (Array.isArray(value) ? value.map((v) => String(v).trim()).filter(Boolean) : []);
  return {
    name,
    aliases: list(brand.aliases),
    productAliases: list(brand.product_aliases ?? brand.productAliases),
    excludePatterns: list(brand.exclude_patterns ?? brand.excludePatterns),
  };
}

/**
 * 检索对话。
 *
 * 三种定位方式，可组合：
 *   - q          关键词，在「问题 + 回答」合并文本里子串匹配（走 trigram 索引）
 *   - brands     品牌命中，语义与报告口径完全一致
 *   - platform   限定平台
 *
 * 结果按 run_id 倒序（最新优先），并带命中位置与上下文，让调用方能直接引用。
 */
export async function searchAnswers(client, options = {}) {
  const {
    tenantId,
    taskId = null,
    groupId = null,
    q = null,
    brands = [],
    platforms = null,
    limit = DEFAULT_LIMIT,
    offset = 0,
  } = options;

  if (!taskId && !groupId) fail("task_id or group_id is required");
  const boundedLimit = positiveInt(limit, "limit", DEFAULT_LIMIT, MAX_LIMIT);
  const boundedOffset = nonNegativeInt(offset, "offset", 0, 1_000_000);
  const term = q == null || q === "" ? null : String(q).trim();
  if (q != null && q !== "" && !term) fail("q must not be blank");

  const parsedBrands = (Array.isArray(brands) ? brands : [])
    .slice(0, 20)
    .map(parseBrand);

  // 与 listAnswers 同构：先按租户圈定批次集合，后续查询只用这批 ID
  const scopeSql = groupId
    ? `SELECT DISTINCT b.id AS batch_id, b.provider
         FROM service_task_executions e
         JOIN service_task_group_members m ON m.task_id = e.task_id
         JOIN service_task_groups g ON g.id = m.group_id
         JOIN sampling_batches b ON b.id = e.batch_id
        WHERE g.tenant_id = $1 AND g.public_id = $2`
    : `SELECT DISTINCT b.id AS batch_id, b.provider
         FROM service_task_executions e
         JOIN service_tasks t ON t.id = e.task_id
         JOIN sampling_batches b ON b.id = e.batch_id
        WHERE t.tenant_id = $1 AND t.public_id = $2`;

  const { rows: scope } = await client.query(scopeSql, groupId ? [tenantId, groupId] : [tenantId, taskId]);
  if (!scope.length) {
    fail(groupId ? "task group was not found" : "task was not found", 404,
      groupId ? "group_not_found" : "task_not_found");
  }

  let batchIds = scope.map((row) => Number(row.batch_id));
  const platformSet = Array.isArray(platforms) && platforms.length
    ? new Set(platforms.map((p) => String(p).trim().toLowerCase()).filter(Boolean))
    : null;
  if (platformSet) {
    batchIds = scope.filter((row) => platformSet.has(String(row.provider).toLowerCase()))
      .map((row) => Number(row.batch_id));
  }
  if (!batchIds.length) fail("no collection batches match the requested platforms", 422, "no_batches");

  const params = [batchIds];
  // 口径必须与报告的品牌提及统计完全一致，否则调用方会发现
  // 「检索说 72 条、报告说 69 条」而不再信任任何数字：
  //   - 只用成功且确认新会话的回答
  //   - 排除平台没写完的回答（截断 / 被预算掐断）
  //   - 排除短到不可能是完整回答的（平台检索中间态，如「找到 1 篇资料」）
  const filters = [
    "r.status = 'success'",
    "r.conversation_reset_confirmed IS TRUE",
    `length(COALESCE(r.answer, '')) >= ${MIN_USABLE_ANSWER_CHARS}`,
    "COALESCE(r.answer_truncated, false) IS NOT TRUE",
    "COALESCE(r.answer_completion, 'follow-up-chips') NOT IN ('timeout', 'length-stability-fallback')",
  ];
  if (term) {
    params.push(term);
    // 走 search_text 的 trigram 索引（迁移 0032），不扫全文
    filters.push(`r.search_text ILIKE '%' || $${params.length} || '%'`);
  }

  // 品牌过滤必须在内存匹配之前落到 SQL。
  //
  // 早期版本把品牌匹配放在内存里（为了复用 detectBrandMention 保证口径一致），
  // 但 total / 分页却在匹配之前算 —— 于是返回的是全部回答，未命中的混在结果里，
  // 「检索命中 122 条」而「报告说 69 条提到」，两个数字对不上。
  // 调用方一旦发现这种不一致就不会再信任整份报告。
  //
  // 解决办法：用同一套 compileBrandRules 生成的模式做 SQL 预筛，缩小候选集；
  // 内存里再用 detectBrandMention 精确判定（它处理重叠、排除模式等 SQL 表达不了的规则）。
  // 两层用同一份规则生成，口径不会漂。
  if (parsedBrands.length) {
    const alternatives = parsedBrands
      .map((brand) => {
        const terms = [brand.name, ...brand.aliases, ...brand.productAliases];
        return terms
          .filter(Boolean)
          .map((t) => `r.answer ILIKE '%' || $${params.push(t)} || '%'`)
          .join(" OR ");
      })
      .join(" OR ");
    filters.push(`(${alternatives})`);
  }

  const where = filters.join(" AND ");

  // 候选集完整取回、不在 SQL 侧分页。
  //
  // 原因：品牌命中要靠内存里的 detectBrandMention 判定（exclude_patterns、
  // 重叠消解这些规则 SQL 表达不了）。如果 SQL 侧先 LIMIT/OFFSET，
  // total 和翻页边界都只能基于预筛结果 —— 实测会出现
  // 「检索说 122 条、报告说 69 条」这种对不上的情况。
  //
  // 代价是候选集全进内存。品牌参数已经把候选集收敛到含该词的子集，
  // 正常使用规模（几百到几千条回答）完全可接受；真正的规模兜底在
  // candidate_cap —— 触顶时如实标记 total_is_exact=false。
  const candidateCap = 20_000;
  const { rows } = await client.query(
    `SELECT r.id, r.local_run_id, r.provider, r.sampling_batch_id,
            r.answer_truncated, r.answer_completion, r.captured_citation_count,
            p.prompt AS question, r.answer
       FROM runs r
       JOIN prompts p ON p.id = r.prompt_id
      WHERE r.sampling_batch_id = ANY($1::bigint[]) AND ${where}
      ORDER BY r.id DESC
      LIMIT $${params.length + 1}`,
    [...params, candidateCap],
  );
  const candidateTotal = rows.length;
  const truncatedByCap = candidateTotal >= candidateCap;

  // 品牌命中在内存里算：品牌数与命中数都远小于 SQL 里的正则匹配，
  // 而复用 detectBrandMention 才能保证与报告口径一致。
  const compiled = parsedBrands.map((brand) => ({
    brand,
    rules: compileBrandRules({
      name: brand.name,
      aliases: brand.aliases,
      productAliases: brand.productAliases,
      excludePatterns: brand.excludePatterns,
    }),
  }));

  const allItems = [];
  for (const row of rows) {
    const matches = [];
    for (const { brand, rules } of compiled) {
      const hit = detectBrandMention(row.answer, rules);
      if (hit.mentioned !== true) continue;
      const at = hit.firstMentionPosition ?? 0;
      matches.push({
        name: brand.name,
        mention_count: hit.mentionCount,
        first_position: at,
        matched_terms: hit.matchedTerms.map((t) => t.term),
        context: safeContext(row.answer, at, brand.name.length, 90),
      });
    }
    // 传了 brands 就只返回命中的：SQL 预筛是「可能含这些词」，内存判定才是「确实提到了」。
    // 混在一起会让 total 与报告口径对不上。
    if (compiled.length && matches.length === 0) continue;
    allItems.push({
      run_id: row.local_run_id,
      batch_id: Number(row.sampling_batch_id),
      platform: row.provider,
      question: row.question,
      answer_chars: row.answer?.length ?? 0,
      answer_truncated: row.answer_truncated === true,
      answer_completion: row.answer_completion ?? null,
      citation_count: Number(row.captured_citation_count ?? 0),
      // 关键词命中位置，便于调用方高亮
      term_position: term ? findTerm(row.answer ?? row.question ?? "", term) : null,
      brand_matches: matches,
      // 只在调用方显式要求时给正文，避免默认把几十 KB 塞进响应
      ...(options.includeAnswer ? { answer: row.answer } : {}),
    });
  }

  // 候选集已完整取回并逐条判定，所以 total 是精确命中数，
  // 与报告里的 brand_mentions.mentioned_answers 完全一致。
  const total = allItems.length;
  const items = allItems.slice(boundedOffset, boundedOffset + boundedLimit);

  return {
    schema: "answer-search.v1",
    query: term,
    brands: parsedBrands.map((b) => b.name),
    // candidate_total：SQL 预筛命中数。total：内存精确匹配数。
    // 传了 brands 时两者可能不等（exclude_patterns / 重叠消解 SQL 表达不了），
    // 报出来是为了让调用方不把预筛数当成最终命中数。
    candidate_total: candidateTotal,
    total,
    // 候选集触到上限时 total 不再完整，必须说清楚而不是让调用方以为拿到了全部
    total_is_exact: !truncatedByCap,
    truncated_by_cap: truncatedByCap,
    returned: items.length,
    limit: boundedLimit,
    offset: boundedOffset,
    has_more: boundedOffset + items.length < total,
    next_offset: boundedOffset + items.length < total ? boundedOffset + items.length : null,
    answers: items,
    interpretation: {
      provided_by: "onegl",
      role: "answer_search",
      conclusion: null,
      guidance:
        "answer 字段默认不返回，需要 include_answer=true 才带全文 —— 命中几十条时全文会很大。" +
        "brand_matches 里的 context 是该品牌首次出现处的上下文，够 agent 判断" +
        "「是被推荐还是被顺带提及」；需要更多原文时用 answers/{runId} 取单条全文。" +
        "total 与报告里的 brand_mentions.mentioned_answers 是同一个口径：" +
        "同一个品牌列表，两边应该得到相同的数字。",
    },
  };
}

function findTerm(text, term) {
  const at = String(text ?? "").toLowerCase().indexOf(term.toLowerCase());
  return at >= 0 ? at : null;
}

/**
 * 取单条回答全文。
 *
 * 检索端点默认不返回 answer（命中几十条时体积太大），需要逐条细看时走这里。
 * 租户边界靠「先按 tenant_id 圈定批次集合，再在该集合内按 run_id 查」实现，
 * 与 searchAnswers 同构 —— 不能只按 run_id 查，那会跨租户泄漏。
 */
export async function getAnswerByRunId(client, { tenantId, taskId = null, groupId = null, runId }) {
  if (!taskId && !groupId) fail("task_id or group_id is required");
  if (!/^run_[A-Za-z0-9_-]+$/.test(String(runId ?? ""))) fail("run_id is malformed");

  const scopeSql = groupId
    ? `SELECT DISTINCT b.id AS batch_id
         FROM service_task_executions e
         JOIN service_task_group_members m ON m.task_id = e.task_id
         JOIN service_task_groups g ON g.id = m.group_id
         JOIN sampling_batches b ON b.id = e.batch_id
        WHERE g.tenant_id = $1 AND g.public_id = $2`
    : `SELECT DISTINCT b.id AS batch_id
         FROM service_task_executions e
         JOIN service_tasks t ON t.id = e.task_id
         JOIN sampling_batches b ON b.id = e.batch_id
        WHERE t.tenant_id = $1 AND t.public_id = $2`;

  const { rows: scope } = await client.query(scopeSql, groupId ? [tenantId, groupId] : [tenantId, taskId]);
  if (!scope.length) {
    fail(groupId ? "task group was not found" : "task was not found", 404,
      groupId ? "group_not_found" : "task_not_found");
  }
  const batchIds = scope.map((row) => Number(row.batch_id));

  const { rows } = await client.query(
    `SELECT r.local_run_id, r.provider, r.sampling_batch_id, r.answer,
            length(r.answer) AS answer_chars, r.answer_truncated, r.answer_completion,
            r.captured_citation_count, p.prompt AS question
       FROM runs r JOIN prompts p ON p.id = r.prompt_id
      WHERE r.sampling_batch_id = ANY($1::bigint[]) AND r.local_run_id = $2`,
    [batchIds, runId],
  );
  const row = rows[0];
  if (!row) fail("answer was not found in this scope", 404, "answer_not_found");

  return {
    schema: "answer-detail.v1",
    run_id: row.local_run_id,
    batch_id: Number(row.sampling_batch_id),
    platform: row.provider,
    question: row.question,
    answer: row.answer,
    answer_chars: Number(row.answer_chars ?? 0),
    answer_truncated: row.answer_truncated === true,
    answer_completion: row.answer_completion ?? null,
    citation_count: Number(row.captured_citation_count ?? 0),
  };
}

export const answerSearchConstants = { MAX_LIMIT, DEFAULT_LIMIT };
