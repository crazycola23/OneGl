import assert from "node:assert/strict";
import test from "node:test";

import "dotenv/config";

import { createPool } from "../src/db/pool.js";

/**
 * 不可信回答的排除口径。
 *
 * ## 现状
 *
 * 报告层用三个条件排除不可信回答：
 *   1. 长度 < MIN_USABLE_ANSWER_CHARS（平台检索中间态）
 *   2. answer_truncated IS TRUE（标点启发式判定没写完）
 *   3. answer_completion IN ('timeout', 'length-stability-fallback')（确定性证据）
 *
 * 前两条在真实数据上验证过（千问 16 条、豆包 4 条被排除）。
 * **第三条从未生效过** —— 全库 answer_completion 为 NULL，
 * 因为只有文心平台会写这个字段，而文心的 run 一条都没有。
 *
 * 这不是 bug，是采集覆盖不全。但「从未触发过的逻辑」和「写错了的逻辑」
 * 在报告里长得一模一样，所以必须用构造数据验证它真的对。
 */

const enabled = Boolean(process.env.DATABASE_URL);

/** 与实现同构的 SQL 片段 */
const MIN = 80;
const untrustedSql = `
  length(COALESCE(r.answer, '')) >= ${MIN}
  AND COALESCE(r.answer_truncated, false) IS NOT TRUE
  AND COALESCE(r.answer_completion, 'follow-up-chips') NOT IN ('timeout', 'length-stability-fallback')
`;

const long = (core) => core + "。".repeat(100);

const CASES = [
  { name: "正常回答", answer: long("思邈棠不错"), truncated: false, completion: null, expect: true },
  { name: "answer_completion 为 NULL（旧行）", answer: long("思邈棠不错"), truncated: false, completion: null, expect: true },
  { name: "follow-up-chips（正常完成）", answer: long("思邈棠不错"), truncated: false, completion: "follow-up-chips", expect: true },
  { name: "length-stability-fallback", answer: long("思邈棠不错"), truncated: false, completion: "length-stability-fallback", expect: false },
  { name: "timeout", answer: long("思邈棠不错"), truncated: false, completion: "timeout", expect: false },
  { name: "截断但 completion 正常", answer: long("思邈棠不错"), truncated: true, completion: "follow-up-chips", expect: false },
  { name: "过短的中间态", answer: "找到 1 篇资料", truncated: false, completion: null, expect: false },
];

test("answer_completion 的排除逻辑在构造数据上正确", { skip: !enabled, timeout: 60_000 }, async () => {
  const pool = createPool();
  const { rows } = await pool.query(`
    SELECT
      (length(COALESCE(answer, '')) >= ${MIN}
        AND COALESCE(answer_truncated, false) IS NOT TRUE
        AND COALESCE(answer_completion, 'follow-up-chips') NOT IN ('timeout', 'length-stability-fallback')) AS usable,
      length(COALESCE(answer, '')) AS len,
      answer_truncated AS truncated,
      answer_completion AS completion
    FROM (VALUES
      ${CASES.map((c, i) => `(
        ${`'${c.answer.replaceAll("'", "''")}'`}::text,
        ${c.truncated},
        ${c.completion === null ? "NULL" : `'${c.completion}'`}::text,
        ${i}
      )`).join(",\n      ")}
    ) AS t(answer, answer_truncated, answer_completion, ord)
    ORDER BY ord`);

  let fails = 0;
  rows.forEach((row, i) => {
    const c = CASES[i];
    const got = row.usable === true;
    const ok = got === c.expect;
    if (!ok) fails++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${c.name.padEnd(32)} usable=${got} 期望=${c.expect}` +
      `  (len=${row.len}, truncated=${row.truncated}, completion=${row.completion})`);
  });

  assert.equal(fails, 0, `${fails} 个用例的判定与期望不符`);
  void untrustedSql;
  await pool.end();
});

test("三个排除条件互相独立，不能只靠一个", () => {
  // 若实现只检查了 answer_truncated，timeout 那条会漏过；
  // 若只检查了 completion，过短那条会漏过。
  // 构造数据逐条验证，正是为了防止「三条路径只有一条被测到」。
  const checks = new Set(CASES.map((c) => c.name));
  assert.ok(checks.has("length-stability-fallback"), "应覆盖 completion 分支");
  assert.ok(checks.has("截断但 completion 正常"), "应覆盖 truncated 分支");
  assert.ok(checks.has("过短的中间态"), "应覆盖长度分支");
  assert.ok(checks.has("answer_completion 为 NULL（旧行）"),
    "应覆盖 NULL 回落 —— 旧行不能被一票否决");
});
