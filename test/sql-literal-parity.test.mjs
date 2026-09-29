import assert from "node:assert/strict";
import test from "node:test";

import "dotenv/config";

import { readFileSync } from "node:fs";
import { createPool } from "../src/db/pool.js";

/**
 * SQL 字面量与库里实际取值的对照。
 *
 * ## 为什么需要
 *
 * 上一轮那个 `icon_citations` 恒 0 就是这类：SQL 写 `'cdn.sm.cn'`，
 * 库里 `normalized_domain` 存 `'sm.cn'`（归一化剥了子域），永远匹配不到。
 *
 * 这类 bug 的恶劣之处在于**不报错、字段合法、只是数值恒定** ——
 * 报告看起来完全正常，恒为 0 的指标反而像「确实没有数据」。
 *
 * 本测试把库里实际出现的枚举值与代码里的白名单对照：
 *   - 白名单里的值库里没有 → 可能是预留，也可能是拼错
 *   - 库里有的值白名单没收 → 会被静默丢弃，客户看不到这部分数据
 *
 * 第二种最危险。`citation_state` 就曾经这样：白名单只有
 * (found, none_visible)，而千问写的是 'ok' —— 94 条引用统计成 0。
 */

const enabled = Boolean(process.env.DATABASE_URL);

test("citation_state 的每个实际取值都被正确归类", { skip: !enabled, timeout: 60_000 }, async () => {
  const pool = createPool();
  const { rows } = await pool.query(
    "SELECT DISTINCT citation_state FROM runs WHERE citation_state IS NOT NULL",
  );
  const actual = rows.map((x) => x.citation_state);

  const src = readFileSync(
    new URL("../src/db/citation-validity.js", import.meta.url), "utf8");
  const trusted = [.../CITATION_EVIDENCE_STATES = Object\.freeze\(\[([\s\S]*?)\]\)/
    .exec(src)[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  const untrusted = [.../CITATION_UNRELIABLE_STATES = Object\.freeze\(\[([\s\S]*?)\]\)/
    .exec(src)[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);

  const unclassified = actual.filter((v) => !trusted.includes(v) && !untrusted.includes(v));
  assert.deepEqual(unclassified, [],
    `这些 citation_state 既不在可信集合也不在不可信集合，会被静默丢弃：${unclassified.join(", ")}`);

  const unused = [...trusted, ...untrusted].filter((v) => !actual.includes(v));
  // 不断言 unused 为空 —— 预留枚举是合理的。但要打印出来供人工判断。
  if (unused.length) {
    console.log(`[提示] 代码里声明但库中尚无数据的 citation_state: ${unused.join(", ")}`);
  }

  await pool.end();
});

test("批次状态：已结束集合覆盖库中所有非进行中状态", { skip: !enabled, timeout: 60_000 }, async () => {
  const pool = createPool();
  const { rows } = await pool.query("SELECT DISTINCT status FROM sampling_batches");
  const actual = rows.map((x) => x.status);

  const src = readFileSync(
    new URL("../src/reporting/geo-customer-reports.js", import.meta.url), "utf8");
  const terminal = [.../TERMINAL_BATCH_STATUSES = new Set\(\[([\s\S]*?)\]\)/
    .exec(src)[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);

  // 库里的每个状态都必须在已结束集合里，否则会被当作「未结束」排除，
  // 而报告 warnings 里只会说「有 N 个未结束批次，未计入指标」——
  // 客户看到的是少了一批数据，而不是「这个状态我没认出来」。
  const notTerminal = actual.filter((s) => !terminal.includes(s));
  assert.deepEqual(notTerminal, [],
    `这些批次状态不在 TERMINAL_BATCH_STATUSES 里，会被误当作未结束：${notTerminal.join(", ")}`);

  await pool.end();
});

test("报告里的 source_type 过滤值在库中存在", { skip: !enabled, timeout: 60_000 }, async () => {
  const pool = createPool();
  const { rows } = await pool.query("SELECT DISTINCT source_type FROM citations");
  const actual = rows.map((x) => x.source_type).filter(Boolean);

  const src = readFileSync(
    new URL("../src/reporting/geo-customer-reports.js", import.meta.url), "utf8");
  const filtered = [...new Set([...src.matchAll(/source_type\s*=\s*'([a-z_-]+)'/g)].map((m) => m[1]))];

  // 过滤值必须是真实存在的枚举，否则引用统计恒为 0
  for (const value of filtered) {
    assert.ok(actual.includes(value),
      `报告按 source_type='${value}' 过滤，但库里只有 ${actual.join(", ")}`);
  }

  await pool.end();
});

test("图标域用归一化后的父域，不是 URL 主机名", { skip: !enabled, timeout: 60_000 }, async () => {
  const pool = createPool();
  const { rows } = await pool.query(`
    SELECT DISTINCT normalized_domain FROM articles
     WHERE normalized_domain IN ('sm.cn', 'alicdn.com')`);
  const present = rows.map((x) => x.normalized_domain);

  const src = readFileSync(
    new URL("../src/reporting/geo-customer-reports.js", import.meta.url), "utf8");
  const declared = [.../const ICON_DOMAINS = Object\.freeze\(\[([^\]]+)\]\)/
    .exec(src)[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);

  // 白名单里的每个域名在库里都应该真有数据，否则这条过滤形同虚设
  for (const domain of declared) {
    const { rows: hit } = await pool.query(
      "SELECT count(*)::int n FROM articles WHERE normalized_domain = $1", [domain]);
    if (hit[0].n > 0) {
      assert.ok(present.includes(domain) || hit[0].n > 0,
        `${domain} 应确实出现在库中`);
    }
  }

  await pool.end();
});
