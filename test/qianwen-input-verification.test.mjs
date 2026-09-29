import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * 千问的输入框也必须先清空再填，并回读校验。
 *
 * ## 为什么豆包修完还要改千问
 *
 * 豆包的问题是 `fill()` 整块替换失败导致残留，重试三次都失败。
 * 千问用的是 `pressSequentially` / `keyboard.type` **逐字符输入** ——
 * 整块替换不会失败，所以实测 100 问成功 97。
 *
 * 但**逐字符输入遇到残留反而更糟**：新问题会被**追加**到旧问题后面，
 * 发出去的是一道拼接题。而原实现两条路径都**没有回读校验**，
 * 系统会把拼接题当成提问成功，污染采集数据。
 *
 * 那 3 次 ANSWER_NOT_FOUND（千问提交后 181s 无任何字符产出）很可能就是
 * 这类情况的另一种表现 —— 拼出来的题目触发了平台的静默丢弃。
 *
 * 这属于「没出问题」与「能发现问题」的区别：当前 97% 是运气，
 * 输入框一旦出现残留就既无人发现也无从拦截。
 */

const src = readFileSync(new URL("../src/qianwen.js", import.meta.url), "utf8");

function functionBody(name) {
  const start = src.indexOf(`async function ${name}`);
  assert.ok(start >= 0, `应能找到 ${name}`);
  const declEnd = src.indexOf("{", start);
  const next = src.indexOf("\nasync function", declEnd);
  return src.slice(start, next > declEnd ? next : src.length);
}

test("千问定义了清空编辑器的辅助函数", () => {
  const fn = functionBody("clearComposer");
  assert.match(fn, /textContent\s*=\s*""/, "contenteditable 要清 textContent");
  assert.match(fn, /selectNodeContents/,
    "用全选 + 删除而不是直接赋空 —— Slate 依赖选区感知删除事件");
  assert.match(fn, /new Event\("input"/,
    "必须派发 input 事件，否则 Slate 内部状态不同步");
});

test("千问定义了读回校验", () => {
  const fn = functionBody("readComposerText");
  assert.match(fn, /textContent/, "Slate 的 value 属性不可靠，要读 textContent");
});

test("两条输入路径都先清空", () => {
  // focus 路径：keyboard.type
  assert.match(src, /clearComposer\(composer\);\s*\n\s*await page\.keyboard\.type/,
    "focus 路径必须先清空再输入");
  // 常规路径：pressSequentially（走 fillVerifiedPrompt）
  const fill = functionBody("fillVerifiedPrompt");
  assert.match(fill, /clearComposer\(composer\)/,
    "常规路径也必须先清空");
  assert.ok(fill.indexOf("clearComposer(composer)") < fill.indexOf("pressSequentially"),
    "清空在输入之前");
});

test("回读校验失败时标记 promptSubmitted:false", () => {
  // 这个标记决定 accounts/safety.js 的 canRetryOutcome 是否允许重试：
  // 提问从未送达 → 重试安全；可能已送达 → 重试会造成重复提问。
  const fill = functionBody("fillVerifiedPrompt");
  assert.match(fill, /promptSubmitted:\s*false/,
    "校验失败说明提问未送达，必须标记为可安全重试");
  assert.match(src, /reason:\s*"verification-mismatch",\s*expected, actual/,
    "诊断要记下期望值与实际值 —— 豆包那次就是靠它定位到残留的");
});

test("校验失败抛的是 SUBMISSION_FAILED 而非静默继续", () => {
  const fill = functionBody("fillVerifiedPrompt");
  assert.match(fill, /ErrorCode\.SUBMISSION_FAILED/,
    "校验不过必须失败，不能带着拼接题继续");
  assert.match(fill, /attempts = 3/,
    "要有重试 —— 偶发的输入框状态问题重试一次可能就好了");
});

test("豆包与千问的输入校验判据一致", () => {
  const doubao = readFileSync(new URL("../src/doubao.js", import.meta.url), "utf8");
  // 两边都应有：清空 → 填 → 回读比对 → 不一致则记 expected/actual
  for (const [name, source] of [["豆包", doubao], ["千问", src]]) {
    assert.match(source, /verification-mismatch/, `${name} 应有回读比对`);
    assert.match(source, /clearComposer|clearEditable/, `${name} 应有清空步骤`);
  }
});
