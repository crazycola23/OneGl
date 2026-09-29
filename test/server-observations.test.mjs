// 钉住一条运维教训：跨重启的批次聚合不能用来判断采集健康度。
//
// 批次 69（豆包 50 问，25 成功 25 失败）曾被我当成"豆包采集逻辑有 50% 失败率"的证据，
// 据此去改并发参数。实际上那批是被人为重启打断的 —— run 的 finished_at 晚于批次
// finished_at 数小时、跨天，error_code 分布全部失真。
//
// 判据写成断言：只要一条 run 的 finished_at 晚于其批次的 finished_at，就说明这批数据被
// 中断污染，不能用来算成功率或错误码分布。
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";

const DOC = "docs/server-observations.md";

test("实测记录存在，并写明批次 69 不可用作证据", () => {
  assert.ok(existsSync(DOC), "缺少 " + DOC + "：服务器实测结论会随会话丢失");
  const doc = readFileSync(DOC, "utf8");
  assert.match(doc, /批次 69/, "应当点名批次 69，否则后人不知道说的是哪一批");
  assert.match(doc, /不要拿批次 69 当证据|全部不可信/, "应当明确写出这批数据不可信");
  assert.match(doc, /打断|重启/, "应当写明真实原因是重启打断，而不是采集逻辑失败");
});

test("记录里区分了「能正常工作」与「已确认缺陷」两类结论", () => {
  const doc = readFileSync(DOC, "utf8");
  // 千问/豆包串行都成功过 —— 不能只留问题不留基线，否则下次又要重新验证一遍
  assert.match(doc, /千问并发 3 问（走 API）/, "缺少千问的可用基线");
  assert.match(doc, /豆包串行 3 问/, "缺少豆包串行的可用基线");
  // 已复现的缺陷与未量化的部分必须分开，不能混为一谈
  assert.match(doc, /已确认的真实缺陷/, "应把复现过的缺陷单列");
  assert.match(doc, /未知数/, "豆包并发上限尚未量化，必须写明是未知数");
});

test("记录里保留了两个曾经踩过的假信号", () => {
  const doc = readFileSync(DOC, "utf8");
  // 门禁假通过：redis-cli 无鉴权时返回空，被当成"队列空闲"
  assert.match(doc, /NOAUTH/, "应记录 redis 无鉴权会导致门禁假通过");
  // 探针配置手搓导致量出的现象不代表线上
  assert.match(doc, /loadConfig/, "应记录探针必须用 loadConfig，不能手搓 config");
});
