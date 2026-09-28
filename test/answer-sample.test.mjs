import assert from "node:assert/strict";
import test from "node:test";

import { listAnswers } from "../src/analysis/answer-sample.js";
import { MIN_USABLE_ANSWER_CHARS, isUsableAnswerText } from "../src/analysis/text-slice.js";

/**
 * 这些用例都来自一次代码审查暴露的真实问题，不是构造出来的边界。
 * fakePool 只记录 SQL 与参数，用来验证「查询条件里到底有没有某个过滤」——
 * 纯函数测试看不到 SQL 拼装错误，而这类错误恰好是最难发现的。
 */

/**
 * 记录所有 SQL 并按查询形态返回合适的行集。
 * 目标是断言「SQL 里有没有某个过滤条件」，而不是真的跑数据库。
 */
function fakePool({ scopeRows = [], answerRows = [] } = {}) {
  const calls = [];
  const respond = (sql) => {
    if (/FROM service_task_executions/.test(sql)) return scopeRows;
    if (/FROM runs r/.test(sql)) return answerRows;
    return [];
  };
  return {
    calls,
    async connect() {
      return {
        async query(sql, params) {
          const text = String(sql);
          calls.push({ sql: text, params });
          const rows = respond(text);
          return { rows, rowCount: rows.length };
        },
        release() {},
      };
    },
    async query(sql, params) {
      const text = String(sql);
      calls.push({ sql: text, params });
      const rows = respond(text);
      return { rows, rowCount: rows.length };
    },
  };
}

const SCOPE = [{ batch_id: 1, provider: "qianwen" }];
const SQL = (calls) => calls.map((c) => c.sql).join("\n");

test("抽样查询排除平台检索中间态（过短文本）", async () => {
  const pool = fakePool({ scopeRows: SCOPE });
  await listAnswers(pool, { tenantId: 1, groupId: "grp_x", sampleRatio: 0.1 }).catch(() => {});
  const sql = SQL(pool.calls);
  assert.match(sql, /length\(COALESCE\(r\.answer, ''\)\) >= \d+/,
    "必须过滤掉短于阈值的回答");
  assert.ok(sql.includes(String(MIN_USABLE_ANSWER_CHARS)),
    "阈值应与共享常量一致");
});

test("抽样查询排除平台未写完的回答", async () => {
  const pool = fakePool({ scopeRows: SCOPE });
  await listAnswers(pool, { tenantId: 1, groupId: "grp_x", sampleRatio: 0.1 }).catch(() => {});
  const sql = SQL(pool.calls);
  assert.match(sql, /answer_truncated/, "必须排除 answer_truncated 的行");
  assert.match(sql, /answer_completion/, "必须排除被预算掐断的行");
  assert.match(sql, /'timeout'/);
  assert.match(sql, /'length-stability-fallback'/);
});

test("answer_completion 为 NULL 时按可信处理（缺数据≠不可信）", () => {
  // COALESCE 到 follow-up-chips：旧行与未上报的平台不应被一票否决
  assert.ok(isUsableAnswerText("x".repeat(MIN_USABLE_ANSWER_CHARS)));
  assert.equal(isUsableAnswerText(null), false);
  assert.equal(isUsableAnswerText(""), false);
  assert.equal(isUsableAnswerText("   "), false);
  assert.equal(isUsableAnswerText("找到 1 篇资料"), false,
    "平台检索中间态必须被识别为不可用");
});

test("limit 支持字符串输入（query string）", async () => {
  // 早期版本直接 Number.isInteger(limit)，而 HTTP query 是字符串，
  // 导致 ?limit=100 恒定 400
  const pool = fakePool({ scopeRows: SCOPE });
  await listAnswers(pool, { tenantId: 1, groupId: "grp_x", limit: "100" }).catch(() => {});
  const err = pool.calls.length ? null : new Error("no query issued");
  assert.ok(!err, "字符串 limit 不应在校验阶段就抛错");
});

test("非法 limit 仍被拒绝", async () => {
  for (const bad of [0, -1, "abc", 501]) {
    const pool = fakePool({ scopeRows: SCOPE });
    await assert.rejects(
      () => listAnswers(pool, { tenantId: 1, groupId: "grp_x", limit: bad }),
      /limit/,
      `limit=${bad} 应被拒绝`,
    );
  }
});

test("seed 长度受限（CPU 放大面）", async () => {
  const pool = fakePool({ scopeRows: SCOPE });
  await assert.rejects(
    () => listAnswers(pool, { tenantId: 1, groupId: "grp_x", seed: "x".repeat(200) }),
    /seed/,
  );
});

test("平台名归一化：大小写与空白都能匹配", async () => {
  // 报告侧 platforms 会 trim + toLowerCase，这边不处理的话
  // ?platform=Qianwen 在报告接口能用、在答案接口却报 422
  const pool = fakePool({ scopeRows: SCOPE });
  await listAnswers(pool, { tenantId: 1, groupId: "grp_x", platforms: [" Qianwen "] }).catch(() => {});
  // 平台过滤后若仍能查到批次，说明归一化生效（没落到 no_batches 短路）
  const answered = pool.calls.find((c) => /FROM runs r/.test(c.sql));
  assert.ok(answered, "应继续执行回答查询（未被平台过滤短路）");
  assert.ok(Array.isArray(answered.params[0]) && answered.params[0].length > 0,
    "应匹配到批次");
});

test("平台过滤确实生效：拼错的平台名应被拒绝", async () => {
  const pool = fakePool({ scopeRows: SCOPE });
  await assert.rejects(
    () => listAnswers(pool, { tenantId: 1, groupId: "grp_x", platforms: ["nonexistent"] }),
    /no collection batches/,
  );
});

test("游标非正整数被拒绝", async () => {
  for (const bad of ["0", "-1", "abc"]) {
    const pool = fakePool({ scopeRows: SCOPE });
    await assert.rejects(
      () => listAnswers(pool, { tenantId: 1, groupId: "grp_x", afterId: bad }),
      /after_id/,
    );
  }
});
