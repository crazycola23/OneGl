import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * 千问回读校验不能把「编辑器排版」误判成「输入错误」。
 *
 * ## 真实缺陷
 *
 * 我上轮加校验时用了 `.replace(/\s+/g, " ").trim()`（折叠成空格）。
 * 看起来与豆包口径一致 —— 其实不一致。
 *
 * Slate（千问的编辑器）渲染长文本时会插入软换行。回读拿到的是
 *     "越城区颈肩腰腿调理\n哪家手法好？"
 * 折叠后变成
 *     "越城区颈肩腰腿调理 哪家手法好？"
 * 而期望值是
 *     "越城区颈肩腰腿调理哪家手法好？"
 * 多一个空格 → **误判失败**。
 *
 * 也就是说那个版本把「本来成功的采集」判成了失败 ——
 * 正是这轮要消除的浪费。
 *
 * ## 正确做法
 *
 * 校验的意图是「输入框里是不是我那句话」，不是「排版是否逐字一致」。
 * 编辑器怎么折行与提问内容无关，所以比较时**删除所有空白**。
 * 真填错内容仍会被抓住 —— 错的文字删空白删不掉。
 */

const src = readFileSync(new URL("../src/qianwen.js", import.meta.url), "utf8");

/** 与实现同构 */
const composerText = (value) => String(value ?? "").replace(/\s+/g, "");

test("composerText 删除所有空白而不是折叠成空格", () => {
  assert.match(src, /const composerText = \(value\) => String\(value \?\? ""\)\.replace\(\/\\s\+\/g, ""\)/,
    "必须是删除全部空白 —— 折叠成空格会被软换行误判");
  assert.ok(!/const composerText = .*replace\(\/\\s\+\/g, " "\)/.test(src),
    "折叠成空格的版本会误判");
});

test("编辑器软换行不导致误判", () => {
  const expected = composerText("越城区颈肩腰腿调理哪家手法好？");
  const withSoftWrap = composerText("越城区颈肩腰腿调理\n哪家手法好？");
  assert.equal(withSoftWrap, expected,
    "软换行是排版行为，不应影响「是不是这句话」的判定");
});

test("各种排版差异都不影响判定", () => {
  const base = composerText("越城区颈肩腰腿调理哪家手法好？");
  const variants = [
    "越城区颈肩腰腿调理\n哪家手法好？",
    "越城区颈肩腰腿调理\r\n哪家手法好？",
    "越城区颈肩腰腿调理  哪家手法好？",
    "  越城区颈肩腰腿调理哪家手法好？  ",
    "越城区颈肩腰腿调理哪家手法好？",
    "越城区颈肩腰腿调理\u00A0哪家手法好？",
    // 软换行插在词中间：删掉换行后应恰好还原原文。
    // 注意不能写成「腰腿\n腿调理」—— 那是重复了「腿」，是真错不是排版差异。
    "越城区颈肩腰腿\n调理哪家手法好？",
    "越城区\n颈肩腰腿调理哪家手法好？",
  ];
  for (const v of variants) {
    assert.equal(composerText(v), base, `排版变体不应影响判定: ${JSON.stringify(v)}`);
  }
});

test("真正填错内容仍会被抓住", () => {
  const base = composerText("越城区颈肩腰腿调理哪家手法好？");
  const wrong = [
    "绍兴越城区的推拿店，手法和价格要怎么比较才靠谱？",  // 上一问的残留
    "越城区颈肩腰腿调理哪家手法好",  // 少字
    "越城区颈肩腰腿调理哪家手法好吗？",  // 多字
    "越城区颈肩腰腿调理哪家于法好？",  // 错字
  ];
  for (const w of wrong) {
    assert.notEqual(composerText(w), base,
      `真填错必须被发现（删空白不能把错字也删掉）: ${JSON.stringify(w)}`);
  }
});

test("诊断用可读形式，不用全删空白的串", () => {
  // expected/actual 是给人排查看的。全删空白的字符串看不出「填成了什么」，
  // 而排查输入框问题恰恰要看原文。
  assert.match(src, /const composerTextForLog = /,
    "应保留一个可读形式用于诊断");
  assert.match(src, /expected: composerTextForLog\(/,
    "诊断里 expected 应用可读形式");
  assert.match(src, /actual: composerTextForLog\(/,
    "诊断里 actual 应用可读形式");
});
