import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * 豆包回读校验：expected 与 actual 必须同口径，且要容忍编辑器排版。
 *
 * ## 背景
 *
 * 豆包的 `normalizeText` 被两处语义**不同**的用途共用：
 *   1. 回读校验（fillVerifiedPrompt）—— 要容忍编辑器排版
 *   2. 比对回答是否新增（waitForSubmissionConfirmation）—— 必须严格，
 *      回答里的换行是有意义的段落分隔，抹掉会把两段回答误判成同一段
 *
 * 所以不能改 normalizeText 本身，只能给校验配一个专用归一化。
 *
 * ## 为什么需要（与千问同类）
 *
 * 豆包 composer 可能是 `div[role="textbox"]` 或 `[contenteditable="true"]`
 * （选择器链第 4、5 位），而 readEditableValue 对它们读 textContent ——
 * 富文本渲染长文本时会插入换行节点，这些节点进入 textContent。
 * 于是回读拿到 "A\nB" 而期望值是 "AB" → 误判失败。
 *
 * ## 一个我自己差点犯的错
 *
 * 第一版只把 actual 换成删空白版本，漏了 expected ——
 * 两边口径不一致，永远不相等 → 100% 误判。
 * 语法检查查不出来，只有针对性断言能发现。
 */

const src = readFileSync(new URL("../src/doubao.js", import.meta.url), "utf8");

const normalizeForVerification = (v) => String(v ?? "").replace(/\s+/g, "");
const normalizeText = (v) => String(v ?? "")
  .replace(/ /g, " ")
  .replace(/[ \t]+/g, " ")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

function functionBody(name) {
  const start = src.indexOf(`async function ${name}`);
  assert.ok(start >= 0, `应能找到 ${name}`);
  const declEnd = src.indexOf("{", start);
  const next = src.indexOf("\nasync function", declEnd);
  return src.slice(start, next > declEnd ? next : src.length);
}

test("expected 与 actual 用同一个归一化", () => {
  const body = functionBody("fillVerifiedPrompt");
  const expectedLine = /const expected = (\w+)\(prompt\)/.exec(body);
  const actualLine = /const actual = (\w+)\(/.exec(body);
  const settledLine = /const settled = (\w+)\(/.exec(body);

  assert.ok(expectedLine, "应能找到 expected 的归一化函数");
  assert.ok(actualLine, "应能找到 actual 的归一化函数");
  assert.equal(expectedLine[1], actualLine[1],
    `expected 用 ${expectedLine[1]}、actual 用 ${actualLine[1]} —— 口径不一致会 100% 误判`);
  assert.equal(expectedLine[1], settledLine[1],
    "settled 也要同口径（它是 700ms 后的二次校验）");
});

test("校验专用归一化删除所有空白", () => {
  assert.match(src, /const normalizeForVerification = \(value\) => String\(value \?\? ""\)\.replace\(\/\\s\+\/g, ""\)/,
    "必须删除所有空白 —— 折叠成空格会被富文本折行误判");
});

test("富文本折行不导致误判", () => {
  const expected = normalizeForVerification("越城区颈肩腰腿调理哪家手法好？");
  // contenteditable / role=textbox 渲染长文本时插入的换行节点
  const withWrap = normalizeForVerification("越城区颈肩腰腿调理\n哪家手法好？");
  assert.equal(withWrap, expected, "折行是排版行为，不应影响判定");
});

test("normalizeText 保留给回答文本比对（必须严格）", () => {
  // 比对回答是否新增时，回答里的换行是有意义的段落分隔。
  // 若也删空白，两段不同的回答会被判成同一段 → 提交确认误判。
  const two = normalizeText("第一段回答\n\n第二段回答");
  const one = normalizeText("第一段回答第二段回答");
  assert.notEqual(two, one,
    "normalizeText 必须保留段落分隔，否则比对回答会误判");
  // 且回答比对仍在用它
  assert.match(src, /baseline\.has\(normalizeText\(/,
    "回答文本比对仍应使用 normalizeText");
  assert.ok(!/baseline\.has\(normalizeForVerification\(/.test(src),
    "回答文本比对不能换成删空白版本");
});

test("诊断用可读形式，不参与判定", () => {
  assert.match(src, /const normalizeForLog = /, "应保留可读形式用于诊断");
  assert.match(functionBody("fillVerifiedPrompt"), /normalizeForLog\(/,
    "expected/actual 的诊断值用可读形式");
});

test("真正填错内容仍会被抓住", () => {
  const base = normalizeForVerification("越城区颈肩腰腿调理哪家手法好？");
  const wrong = [
    "绍兴越城区的推拿店，手法和价格要怎么比较才靠谱？", // 上一问残留
    "越城区颈肩腰腿调理哪家手法好",   // 少字
    "越城区颈肩腰腿调理哪家手法好吗？", // 多字
    "越城区颈肩腰腿调理哪家于法好？",   // 错字
  ];
  for (const w of wrong) {
    assert.notEqual(normalizeForVerification(w), base,
      `真填错必须被发现: ${JSON.stringify(w)}`);
  }
});
