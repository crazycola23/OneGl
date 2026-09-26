import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_POOL_MAX, poolMax } from "../src/db/pool.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(root, "..", "src", "db", "pool.js"), "utf8");

test("池上限必须留出余量，不能与并发槽位相等", () => {
  // 2026-09-26 的故障：max 写死 4，而千问匿名面的并发槽位也是 4。账号租约是会话级
  // advisory lock，要独占一条池连接整整一个 attempt（最长 900 秒），于是 4 个槽位一开满，
  // 池里一条空闲连接都不剩 —— accountAvailability / refreshBatchProgress / 引用页分析对账
  // 全部排队，等满 connectionTimeoutMillis 就抛 `timeout exceeded when trying to connect`。
  //
  // 8 是「至少两倍于单平台槽位」的保守线：凭证 2 槽、匿名 4 槽，还要留周期对账与账号扫描。
  assert.ok(
    DEFAULT_POOL_MAX >= 8,
    `默认池上限 ${DEFAULT_POOL_MAX} 太接近并发槽位，租约会把池攥满`,
  );
  assert.ok(DEFAULT_POOL_MAX < 100, "上限不该逼近 PostgreSQL 的 max_connections");
});

test("池上限的读取只认合法覆盖值，且不低于改造前的 4", () => {
  const original = process.env.ONEGL_DB_POOL_MAX;
  try {
    delete process.env.ONEGL_DB_POOL_MAX;
    assert.equal(poolMax(), DEFAULT_POOL_MAX, "没有覆盖时用默认值");

    process.env.ONEGL_DB_POOL_MAX = "24";
    assert.equal(poolMax(), 24, "合法的覆盖值应当生效");

    // 比改造前更小的值一律回落：调小它正是这次故障的成因，不该允许被「顺手」配回去。
    process.env.ONEGL_DB_POOL_MAX = "2";
    assert.equal(poolMax(), DEFAULT_POOL_MAX, "低于 4 的覆盖值必须回落");

    process.env.ONEGL_DB_POOL_MAX = "abc";
    assert.equal(poolMax(), DEFAULT_POOL_MAX, "非数字覆盖值必须回落");

    process.env.ONEGL_DB_POOL_MAX = "8.5";
    assert.equal(poolMax(), DEFAULT_POOL_MAX, "非整数覆盖值必须回落");
  } finally {
    if (original === undefined) delete process.env.ONEGL_DB_POOL_MAX;
    else process.env.ONEGL_DB_POOL_MAX = original;
  }
});

test("池上限走 poolMax()，不再写死一个与并发度无关的数字", () => {
  // 防的是「改回来了但只改了注释」。注释里讲清了余量的道理，代码里却写死数字，下一轮还会踩。
  // 只做正面断言：源码注释里必然会提到改造前的 `max: 4`，用否定式断言会被自己的注释绊倒。
  assert.match(source, /max:\s*poolMax\(\)/, "createPool 的上限必须来自 poolMax()");
  assert.match(
    source,
    /export function poolMax\(\)/,
    "poolMax 要导出，否则这个上限没法被单独测",
  );
});
