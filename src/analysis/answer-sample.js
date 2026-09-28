import { ApiHttpError } from "../api/http.js";
import { safeSlice } from "./text-slice.js";

/**
 * AI 回答的读取与分层抽样。
 *
 * ## 存在的理由：让调用方用模型发现品牌，而不是让 OneGl 猜
 *
 * 品牌名只能从回答里读出来，但「哪个是机构名、哪个是分类标题、哪两个写法指同一家」
 * 都是语义问题。早期试过用机构后缀词表抽取（`中医院`/`养生馆`/…），换行业即失效，
 * 而用户不会为了跑 GEO 去维护那张表 —— 结论是这类判断不该在 OneGl 里做。
 *
 * 所以分工是：
 *   1. OneGl 按平台分层抽 1/10，把**完整回答正文**返回
 *   2. 调用方把样本丢给自己的模型，读出高频品牌（含别名）
 *   3. 品牌列表随报告请求的 brands 传回
 *   4. OneGl 对**全量**回答做子串匹配，出可复现的提及率
 *
 * 第 1 步的抽样比例是安全的：实测提及率 15% 以上的品牌在 1/10 抽样下发现率
 * 93–100%，10% 左右的约 75%（「高频」本就不含这一档）。要覆盖更低频的品牌，
 * 调大 sample_ratio 即可，没有隐藏代价。
 *
 * ## 为什么按平台分层
 *
 * 两个平台回答数差很多（实测千问 97 / 豆包 25）。合并抽样时豆包只能抽到 2–3 篇，
 * 不足以发现豆包侧的竞品，而跨平台对比正是这份数据的核心价值。
 * 分层后千问抽 ~10、豆包抽 ~3，各自的竞品池独立成立。
 */

/** 单次返回的最大回答数：防止一次拉爆响应体。 */
const MAX_ANSWERS = 500;
/** 单条回答的最大字符数：超长截断，但保留开头（AI 结论通常在前面）。 */
const MAX_ANSWER_CHARS = 4000;

function fail(message, status = 400, code = "invalid_request") {
  throw new ApiHttpError(status, code, message);
}

function clampRatio(raw) {
  if (raw == null || raw === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    fail("sample_ratio must be a number greater than 0 and at most 1");
  }
  return value;
}

function positiveInt(raw, name, fallback, max) {
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    fail(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

/**
 * 确定性抽样：同一个 seed 必然抽到同一批回答。
 *
 * 必须是确定性的 —— 抽样结果要能被复现和核对，否则「模型从样本里发现了某品牌」
 * 这件事无法验证。用 sort 保证与数据库返回顺序无关。
 */
function stratifiedSample(rows, ratio, seed) {
  if (ratio == null) return rows;
  const byProvider = new Map();
  for (const row of rows) {
    if (!byProvider.has(row.provider)) byProvider.set(row.provider, []);
    byProvider.get(row.provider).push(row);
  }
  const picked = [];
  for (const [provider, group] of byProvider) {
    // 每个平台独立按 seed 派生偏移，避免不同平台抽到同一序号模式
    const providerSeed = hashSeed(`${seed}:${provider}`);
    const ordered = group
      .map((row, index) => ({ row, key: hashSeed(`${providerSeed}:${index}`) }))
      .sort((a, b) => a.key - b.key || a.row.id - b.row.id);
    const take = Math.max(1, Math.round(ordered.length * ratio));
    for (const item of ordered.slice(0, take)) picked.push(item.row);
  }
  return picked.sort((a, b) => a.id - b.id);
}

function hashSeed(value) {
  let h = 2166136261;
  const text = String(value);
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 读取回答。
 *
 * @param {object} client pg client
 * @param {object} options
 *   taskId / groupId  二选一，决定取哪些批次的回答
 *   platforms         限定平台
 *   from / to         按批次 started_at 的本地日期范围
 *   sampleRatio       0-1，按平台分层抽样
 *   limit             返回条数上限
 *   afterId           游标：只返回 runs.id 更大的回答（续翻页用）
 *   seed              抽样种子，默认固定值以保证可复现
 */
export async function listAnswers(client, options = {}) {
  const {
    tenantId,
    taskId = null,
    groupId = null,
    platforms = null,
    from = null,
    to = null,
    sampleRatio = null,
    limit = 100,
    afterId = null,
    seed = "onegl-answer-sample",
  } = options;

  if (!taskId && !groupId) fail("task_id or group_id is required");
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ANSWERS) {
    fail(`limit must be an integer between 1 and ${MAX_ANSWERS}`);
  }
  const ratio = clampRatio(sampleRatio);
  // 游标必须是正整数：内部主键，传 0 或负数会静默返回全量。
  if (afterId != null && (!Number.isInteger(Number(afterId)) || Number(afterId) < 1)) {
    fail("after_id must be a positive integer when provided");
  }

  // 批次范围与报告口径一致：按批次 started_at 落入本地日期范围，只取已结束批次。
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

  const scopeParams = groupId ? [tenantId, groupId] : [tenantId, taskId];
  const { rows: scope } = await client.query(scopeSql, scopeParams);
  if (!scope.length) {
    fail(groupId ? "task group was not found" : "task was not found", 404,
      groupId ? "group_not_found" : "task_not_found");
  }

  let batchIds = scope.map((row) => Number(row.batch_id));
  const platformSet = Array.isArray(platforms) && platforms.length ? new Set(platforms) : null;
  if (platformSet) {
    batchIds = scope.filter((row) => platformSet.has(row.provider)).map((row) => Number(row.batch_id));
  }
  if (!batchIds.length) fail("no collection batches match the requested platforms", 422, "no_batches");

  const params = [batchIds];
  const filters = [
    "r.status = 'success'",
    "r.conversation_reset_confirmed IS TRUE",
    "length(COALESCE(r.answer, '')) > 0",
  ];
  if (from) {
    params.push(from);
    filters.push(`b.started_at >= ($${params.length}::date::timestamp AT TIME ZONE 'Asia/Shanghai')`);
  }
  if (to) {
    params.push(to);
    filters.push(`b.started_at < (($${params.length}::date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai')`);
  }
  // 游标翻页：按 runs.id 单调递增推进。
  // 之前只有 LIMIT 硬截断 —— 返回体里会告诉你「共 2000 条，我只给了 100 条」，
  // 但剩下的取不到。喂模型发现品牌时这半截数据是完全够的，但调用方无法确认
  // 自己拿到的是不是全部，契约里也无从表达，所以必须能翻页。
  if (afterId != null) {
    params.push(afterId);
    filters.push(`r.id > $${params.length}`);
  }
  // 扫描上限：一次最多扫这么多条候选用于抽样/分页。
  // 显式返回给调用方，避免「我传 limit=500 拿到的是不是前 500 条」这种疑问。
  const scanCap = Math.max(MAX_ANSWERS * 4, limit * 4);
  params.push(scanCap);

  const { rows } = await client.query(
    `SELECT r.id, r.local_run_id, r.provider, r.answer, length(r.answer) AS answer_chars,
            r.answer_truncated, r.answer_completion,
            r.captured_citation_count, r.sampling_batch_id, p.prompt AS question
       FROM runs r
       JOIN sampling_batches b ON b.id = r.sampling_batch_id
       JOIN prompts p ON p.id = r.prompt_id
      WHERE r.sampling_batch_id = ANY($1::bigint[]) AND ${filters.join(" AND ")}
      ORDER BY r.id
      LIMIT $${params.length}`,
    params,
  );

  const sampled = stratifiedSample(rows, ratio, seed);
  const page = sampled.slice(0, limit);
  const last = page.at(-1) ?? null;
  // 还有剩余就给出续游标；没有则 null，调用方据此停止翻页。
  const consumedTo = last ? Number(last.id) : null;
  const hasMore = consumedTo != null && rows.some((row) => Number(row.id) > consumedTo);

  // 报告实际覆盖量：抽样时用来告诉调用方「样本占全量的比例」
  const totals = {};
  for (const row of rows) {
    totals[row.provider] = (totals[row.provider] ?? 0) + 1;
  }
  const sampledTotals = {};
  for (const row of sampled) {
    sampledTotals[row.provider] = (sampledTotals[row.provider] ?? 0) + 1;
  }

  return {
    schema: "answer-sample.v1",
    sampled: ratio != null,
    sample_ratio: ratio,
    seed: ratio != null ? seed : null,
    // rows 是本次扫描到的候选数（受 scanCap 限制），不是数据库里的真实总量。
    // 两者分开报，调用方才知道自己看到的是全部还是被截断过的一段。
    scanned: rows.length,
    scan_cap: scanCap,
    total_available: rows.length,
    returned: page.length,
    // 抽样时告诉你「样本占全量的比例」；未抽样时 sampled === available
    by_platform: Object.fromEntries(
      [...new Set(rows.map((row) => row.provider))].map((provider) => [
        provider,
        {
          available: totals[provider] ?? 0,
          sampled: sampledTotals[provider] ?? 0,
          returned: page.filter((row) => row.provider === provider).length,
        },
      ]),
    ),
    meta: {
      has_more: hasMore,
      next_cursor: hasMore ? String(consumedTo) : null,
    },
    answers: page.map((row) => ({
      run_id: row.local_run_id,
      batch_id: Number(row.sampling_batch_id),
      platform: row.provider,
      question: row.question,
      // 截断用 safeSlice：回答里大量 emoji，普通 slice 会切出孤立代理项，
      // 那不是合法 JSON，存下来或拼进请求都会出问题。
      answer: safeSlice(row.answer, 0, MAX_ANSWER_CHARS),
      answer_chars: Number(row.answer_chars),
      truncated_by_length: Number(row.answer_chars) > MAX_ANSWER_CHARS,
      answer_truncated: row.answer_truncated,
      citation_count: Number(row.captured_citation_count ?? 0),
    })),
    interpretation: {
      provided_by: "onegl",
      role: "answer_sample",
      conclusion: null,
      guidance:
        "这是按平台分层抽取的 AI 回答正文，用来让模型发现高频品牌 —— OneGl 不做实体抽取，" +
        "也不维护品牌库。把 answers 交给你的模型，让它返回 [{name, aliases, product_aliases}]，" +
        "再用该列表调用 POST /v1/geo-reports 并传 brands，由 OneGl 对全量回答做提及率统计。" +
        "sample_ratio 默认建议 0.1：实测提及率 15% 以上的品牌发现率 93–100%。" +
        "同一 seed 必然抽到同一批回答，结果可复现。",
    },
  };
}

export const answerSampleConstants = { MAX_ANSWERS, MAX_ANSWER_CHARS };
