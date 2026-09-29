import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * 过短的片段不能被当成答案。
 *
 * ## 真实缺陷（实测 2026-09-29，匿名面）
 *
 * 问「What is the boiling point of water at sea level in Celsius?」之后，
 * DOM 里先出现流式开头的 3 个字符 `The`，采集器读到它就收工 ——
 * status 判 success，答案只有 3 个字符。
 *
 * 它通过了当时全部过滤：不是用户气泡、不在 baseline 里、不是占位符。
 * 后果是品牌提及、引用统计、报告里的回答数全算在这 3 个字符上，
 * 而且**不报错**。
 *
 * 这与 ANSWER_NOT_FOUND 是同一类问题的近亲：那边是「一个字都没有」，
 * 这里是「有字但明显没写完」。
 *
 * ## 修复效果（同一问题重跑）
 *
 *   修复前：  3 字符  "The"
 *   修复后： 72 字符 "The boiling point of water at sea level is 100 °C (100 degrees Celsius)."
 */

const src = readFileSync(new URL("../src/doubao.js", import.meta.url), "utf8");

test("定义了最小答案长度", () => {
  assert.match(src, /const MIN_ANSWER_CHARS = \d+/,
    "要有明确的最小长度常量并写清理由");
});

test("阈值合理：远低于实测最短的真实答案", () => {
  const m = /const MIN_ANSWER_CHARS = (\d+)/.exec(src);
  const threshold = Number(m[1]);
  // 实测最短的真实豆包答案："Paris is the capital of France." = 31 字符
  assert.ok(threshold > 3, "必须能挡住实测那个 3 字符的 \"The\"");
  assert.ok(threshold <= 31, "不能高过实测最短的真实答案，否则会误杀正常答案");
});

test("过滤用长度判据，而不只是占位符与基线", () => {
  assert.match(src, /substantive/,
    "要有独立的「够长才算数」这一层");
  assert.match(src, /normalizeText\(item\.text\)\.length >= MIN_ANSWER_CHARS/,
    "长度判据要作用在归一化后的文本上");
  // 关键：current 必须来自 substantive 而不是 usable
  assert.match(src, /const current = substantive\.map\(/,
    "current 要来自长度过滤后的集合 —— 否则过滤形同虚设");
});

test("长度不足时不会立刻判成功，会继续等", () => {
  // 若 short 片段被当成答案，stable 计数会推进并提前收工。
  // 这里只要求结构上 current 来自 substantive —— isSilentlyDropped
  // 那条零输出路径负责「一直没有」的情况，而「有但太短」由长度过滤挡住。
  const body = src.slice(
    src.indexOf("async function waitForAnswer"),
    src.indexOf("\nasync function", src.indexOf("async function waitForAnswer") + 10),
  );
  assert.match(body, /const answer = current\.at\(-1\) \|\| ""/,
    "answer 取自过滤后的 current");
  assert.ok(!/const answer = usable\.map\(.*\.at\(-1\)/s.test(body),
    "不应再从未经长度过滤的 usable 直接取答案");
});

test("注释写明这是实测发现的，不是凭空推断", () => {
  // 实测数据是这个修复存在的唯一理由；写清楚后人才能判断阈值该不该调
  assert.match(src, /实测（2026-09-29/, "应记录实测来源与日期");
  assert.match(src, /boiling point of water/,
    "应保留触发这个修复的具体案例");
});
