import assert from "node:assert/strict";
import test from "node:test";

import { validateExcludePattern } from "../src/brand/detect.js";

/**
 * ReDoS 防护回归测试。
 *
 * 这些用例来自一次安全审查的**实测**结果，不是推断：
 * 旧校验只挡「带括号的无界量词嵌套」，`a*a*a*a*a*a*a*a*a*a*b` 完全绕过，
 * 对 40 字符的回答文本单次 exec 耗时 242 秒 —— 而 detectBrandMention 是
 * 对「每条回答 × 每个品牌」循环调用的，单个 HTTP 请求就能占住事件循环数分钟。
 *
 * 修复思路不是补全形态黑名单（补不全），而是约束「能制造多少种切分的结构」。
 */

const rejects = (pattern, label) => {
  assert.throws(() => validateExcludePattern(pattern), undefined, `应拒绝：${label}`);
};
const accepts = (pattern, label) => {
  validateExcludePattern(pattern); // 不抛即通过
  assert.ok(true, label);
};

test("拒绝相邻无界量词（多项式回溯）", () => {
  // 实测绕过旧校验、耗时 242 秒的载荷
  rejects("a*a*a*a*a*a*a*a*a*a*b", "10 个相邻量词");
  rejects("a*a*a*a*b", "5 个相邻量词");
  rejects("a+a+a+a+a", "5 个 + 量词");
  rejects("x*y*z*w*v*u*", "混合量词");
});

test("拒绝嵌套无界量词（指数回溯）", () => {
  rejects("(a+)+", "基础嵌套");
  rejects("(.*)*", "嵌套点号");
  rejects("((a+)+)", "双层嵌套");
  rejects("(x+x+)+y", "组内相邻量词再量化");
});

test("拒绝量化的分支组", () => {
  // (a|aa)+ 同样是多项式回溯：两分支能匹配同一段文本
  rejects("(a|aa)+", "分支重叠");
  rejects("(a|a?)+", "分支含可选");
  rejects("(foo|bar|baz)+x", "三分支量化");
});

test("拒绝反向引用", () => {
  rejects("([a-z]+)\\1+", "捕获组重复");
  rejects("(a)(b)\\2", "裸反向引用");
});

test("拒绝有界量词的过大展开", () => {
  rejects("a{1,100000}", "单次展开过大");
  rejects("(a{1,100}){1,100}", "嵌套展开");
});

test("拒绝非法正则（不留到运行期）", () => {
  rejects("(", "未闭合括号");
  rejects("[a-", "未闭合字符类");
  rejects("(?<", "未完成断言");
});

test("拒绝超长模式", () => {
  rejects("x".repeat(201), "超过 200 字符");
});

test("放行真实业务里合法的排除规则", () => {
  // 排除规则的实际用途：屏蔽某个词在特定上下文中的出现
  accepts("示例", "字面量");
  accepts("示例|样本", "无量化分支");
  accepts("^示例", "起始锚定");
  accepts("示例$", "结束锚定");
  accepts("示例\\d{2}", "带边界量词");
  accepts("示例{1,3}", "小范围有界量词");
  accepts("(?<![一-龥])示例", "负向后行断言");
  accepts("a+b*c*", "恰好 3 个无界量词（在上限内）");
  accepts("", "空模式（退化为不屏蔽任何内容）");
});

test("放行的形态实际执行耗时可控", () => {
  // 上限内的最坏形态，实测 1.26ms —— 相对一次 122 条回答 × 50 品牌
  // 的循环完全可接受
  const worst = "a*a*a*b";
  const re = new RegExp(worst, "giu");
  const text = "a".repeat(40) + "c";
  const started = process.hrtime.bigint();
  re.exec(text);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 100, `实际耗时 ${ms.toFixed(2)}ms，应远低于 100ms`);
});
