import assert from "node:assert/strict";
import test from "node:test";

import { getAnswerByRunId, searchAnswers } from "../src/analysis/answer-search.js";

/**
 * 对话检索的口径与结构约束。
 *
 * 最重要的一条：**检索的 total 必须等于报告的 brand_mentions.mentioned_answers**。
 * 实测踩过的坑：早期版本品牌匹配在内存里做，但 total 与分页在匹配之前算，
 * 于是「检索说 122 条、报告说 69 条」。调用方一旦发现这种不一致，
 * 就不会再信任整份报告 —— 所以这条必须锁死。
 */

const LONG = (core) => core + "。".repeat(100);

const ANSWERS = [
  { local_run_id: "run_1", provider: "qianwen", question: "哪家好", answer: LONG("推荐思邈棠中式养生调理，辨证后定制方案"), answer_truncated: false, answer_completion: null, captured_citation_count: 10, sampling_batch_id: 68 },
  { local_run_id: "run_2", provider: "qianwen", question: "有推荐吗", answer: LONG("思邈棠值得一试，环境不错"), answer_truncated: false, answer_completion: null, captured_citation_count: 8, sampling_batch_id: 68 },
  { local_run_id: "run_3", provider: "doubao", question: "手法人怎么样", answer: LONG("沈园堂手法老道，价格透明"), answer_truncated: false, answer_completion: null, captured_citation_count: 12, sampling_batch_id: 69 },
  { local_run_id: "run_4", provider: "doubao", question: "本地店", answer: LONG("绍兴市中医院是公立三甲，技术可靠"), answer_truncated: false, answer_completion: null, captured_citation_count: 6, sampling_batch_id: 69 },
  // 以下几条必须被口径过滤掉
  { local_run_id: "run_5", provider: "doubao", question: "短答案", answer: "找到 1 篇资料", answer_truncated: true, answer_completion: null, captured_citation_count: 0, sampling_batch_id: 69 },
  { local_run_id: "run_6", provider: "qianwen", question: "被截断", answer: LONG("思邈棠很好，但是这段没写完"), answer_truncated: true, answer_completion: null, captured_citation_count: 5, sampling_batch_id: 68 },
  { local_run_id: "run_7", provider: "qianwen", question: "超时", answer: LONG("思邈棠很好，综上所述您可以考虑"), answer_truncated: false, answer_completion: "timeout", captured_citation_count: 5, sampling_batch_id: 68 },
];

/** 假 client：按 SQL 里的关键字分派结果 */
function fakePool(answers = ANSWERS, scopeRows = [{ batch_id: 68, provider: "qianwen" }, { batch_id: 69, provider: "doubao" }]) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ sql: text, params });
      if (/FROM service_task_executions/.test(text)) return { rows: scopeRows, rowCount: scopeRows.length };
      if (/FROM runs r/.test(text)) {
        // 单条查询：按 local_run_id 精确匹配
        const single = /AND r\.local_run_id = /.test(text);
        if (single) {
          const hit = answers.find((r) => r.local_run_id === params[1]);
          return { rows: hit ? [{ ...hit }] : [], rowCount: hit ? 1 : 0 };
        }
        // 内存过滤模拟真实 SQL 的 where 子句
        const hasTruncFilter = /answer_truncated/.test(text);
        const hasCompletionFilter = /answer_completion/.test(text);
        const hasLengthFilter = /length\(COALESCE\(r\.answer, ''\)\) >= \d+/.test(text);
        let rows = answers;
        if (hasLengthFilter) rows = rows.filter((r) => r.answer.length >= 80);
        if (hasTruncFilter) rows = rows.filter((r) => r.answer_truncated !== true);
        if (hasCompletionFilter) {
          rows = rows.filter((r) => !["timeout", "length-stability-fallback"].includes(r.answer_completion));
        }
        return {
          rows: rows.map((r) => ({ ...r, answer: r.answer })),
          rowCount: rows.length,
        };
      }
      void params;
      return { rows: [], rowCount: 0 };
    },
  };
}

const LONG_ANSWER = { run_id: "run_1", provider: "qianwen", question: "哪家好", answer: ANSWERS[0].answer };

test("品牌检索只返回命中的回答", async () => {
  const pool = fakePool();
  const r = await searchAnswers(pool, { tenantId: 1, groupId: "grp_x", brands: ["思邈棠"] });
  assert.equal(r.total, 2, "run_1 与 run_2");
  assert.ok(r.answers.every((a) => a.brand_matches.length > 0), "每条都带 brand_matches");
  assert.ok(!r.answers.some((a) => a.run_id === "run_3"), "没提到思邈棠的不返回");
});

test("检索口径与报告一致：截断/超时/过短的回答被排除", async () => {
  const pool = fakePool();
  const r = await searchAnswers(pool, { tenantId: 1, groupId: "grp_x", brands: ["思邈棠"] });
  const ids = r.answers.map((a) => a.run_id);
  // run_5 过短、run_6 被截断、run_7 超时 —— 三条都提到思邈棠但都不该计入
  assert.ok(!ids.includes("run_5"), "过短的平台中间态被排除");
  assert.ok(!ids.includes("run_6"), "被平台截断的被排除");
  assert.ok(!ids.includes("run_7"), "超时掐断的被排除");
  assert.equal(r.total, 2);
});

test("SQL 层就带上口径过滤条件", async () => {
  const pool = fakePool();
  await searchAnswers(pool, { tenantId: 1, groupId: "grp_x", brands: ["思邈棠"] });
  const runQuery = pool.calls.find((c) => /FROM runs r/.test(c.sql));
  assert.ok(runQuery, "应发出 runs 查询");
  assert.match(runQuery.sql, /answer_truncated/, "SQL 含截断过滤");
  assert.match(runQuery.sql, /answer_completion/, "SQL 含完成判据过滤");
  assert.match(runQuery.sql, /length\(COALESCE\(r\.answer, ''\)\) >= \d+/, "SQL 含长度下限");
});

test("关键词检索走 search_text 索引", async () => {
  const pool = fakePool();
  await searchAnswers(pool, { tenantId: 1, groupId: "grp_x", q: "手法" });
  const runQuery = pool.calls.find((c) => /FROM runs r/.test(c.sql));
  assert.match(runQuery.sql, /search_text ILIKE/, "应走 search_text 而非 answer");
});

test("别名与产品名参与匹配", async () => {
  const pool = fakePool();
  const r = await searchAnswers(pool, {
    tenantId: 1, groupId: "grp_x",
    brands: [{ name: "思邈棠", aliases: ["思邈堂"], productAliases: ["思邈棠中式养生"] }],
  });
  assert.equal(r.total, 2);
  const terms = r.answers.flatMap((a) => a.brand_matches.flatMap((m) => m.matched_terms));
  assert.ok(terms.length > 0, "应记录实际命中的词");
});

test("brand_matches 带上下文与命中词", async () => {
  const pool = fakePool();
  const r = await searchAnswers(pool, { tenantId: 1, groupId: "grp_x", brands: ["思邈棠"] });
  const m = r.answers[0].brand_matches[0];
  assert.equal(m.name, "思邈棠");
  assert.ok(m.context.includes("思邈棠"), "上下文含品牌名");
  assert.ok(Number.isInteger(m.first_position));
  assert.ok(Array.isArray(m.matched_terms));
});

test("默认不返回正文，include_answer 才给", async () => {
  const pool = fakePool();
  const without = await searchAnswers(pool, { tenantId: 1, groupId: "grp_x", q: "思邈棠" });
  assert.ok(!("answer" in without.answers[0]), "默认无 answer 字段");
  const withText = await searchAnswers(pool, { tenantId: 1, groupId: "grp_x", q: "思邈棠", includeAnswer: true });
  assert.ok(withText.answers[0].answer.length > 0, "显式要求时有正文");
});

test("offset 允许 0（第一页）", async () => {
  const pool = fakePool();
  const r = await searchAnswers(pool, { tenantId: 1, groupId: "grp_x", q: "思邈棠", offset: 0 });
  assert.equal(r.offset, 0);
});

test("翻页不重不漏", async () => {
  const pool = fakePool();
  const p1 = await searchAnswers(pool, { tenantId: 1, groupId: "grp_x", q: "思邈棠", limit: 1, offset: 0 });
  const p2 = await searchAnswers(pool, { tenantId: 1, groupId: "grp_x", q: "思邈棠", limit: 1, offset: 1 });
  assert.notEqual(p1.answers[0].run_id, p2.answers[0].run_id);
  assert.equal(p1.next_offset, 1);
});

test("租户边界：scope 为空即 404", async () => {
  const pool = fakePool(ANSWERS, []);
  await assert.rejects(() => searchAnswers(pool, { tenantId: 1, groupId: "grp_x", q: "x" }), /not found/);
});

test("缺 scope 报错", async () => {
  const pool = fakePool();
  await assert.rejects(() => searchAnswers(pool, { tenantId: 1, q: "x" }), /task_id or group_id/);
});

test("空白关键词报错", async () => {
  const pool = fakePool();
  await assert.rejects(() => searchAnswers(pool, { tenantId: 1, groupId: "grp_x", q: "   " }), /q must not be blank/);
});

test("getAnswerByRunId 校验 run_id 形态", async () => {
  const pool = fakePool();
  await assert.rejects(
    () => getAnswerByRunId(pool, { tenantId: 1, groupId: "grp_x", runId: "not-a-run" }),
    /malformed/,
  );
});

test("getAnswerByRunId 找不到返回 404", async () => {
  const pool = fakePool();
  await assert.rejects(
    () => getAnswerByRunId(pool, { tenantId: 1, groupId: "grp_x", runId: "run_missing" }),
    /not found/,
  );
});

void LONG_ANSWER;
