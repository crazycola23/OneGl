import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";

/**
 * 豆包输入框必须先清空再填。
 *
 * ## 真实缺陷（实测数据）
 *
 * 批次 69 的 50 问里 **25 问失败（50%）**，其中 16 问是同一条路径：
 * `DOUBAO_SUBMISSION_FAILED: Prompt input verification failed`。
 *
 * 诊断信息直接指出了原因。i28 分配的题目是：
 *     越城区颈肩腰腿调理哪家手法好？
 * 而输入框里回读到的是：
 *     绍兴越城区的推拿店，手法和价格要怎么比较才靠谱？
 *
 * **两条都是本批次的合法题目**，后者正是 i17 的题目 ——
 * 说明是上一问的文本残留，不是平台判定的「损坏文本」。
 *
 * 原来的重试是 `box.fill(prompt)` 重复三次。fill() 对选错的 contenteditable
 * 会静默不生效，于是「重试三次」其实是同样的三次失败 —— 那一问必然失败。
 *
 * 千问同批 100 问成功 97（97%），同样的题目内容没有问题，
 * 佐证这是豆包 composer 的输入残留，不是平台限制。
 */

const src = readFileSync(new URL("../src/doubao.js", import.meta.url), "utf8");

/**
 * 取出某个函数体：从它的声明处到**下一个**顶层 async function。
 *
 * 第一版用 `src.indexOf("async function", start + 10)` —— 那会先匹配到
 * 目标函数自己声明里的 "async function"（因为 start 指向的就是它），
 * 于是「函数体」被切成从声明到几乎全文，判据全失效。
 * 用 start + 长度偏移跳过自身声明。
 */
function functionBody(name) {
  const start = src.indexOf(`async function ${name}`);
  assert.ok(start >= 0, `应能找到 ${name}`);
  const declEnd = src.indexOf("{", start);
  const next = src.indexOf("\nasync function", declEnd);
  assert.ok(next > declEnd, `${name} 之后应有下一个函数`);
  return src.slice(start, next);
}

test("fill 之前必须显式清空输入框", () => {
  const body = functionBody("fillVerifiedPrompt");
  // 不能用 body.indexOf("box.fill(prompt)") 直接比 ——
  // 函数体开头还有另一处 fill（重试循环之前的清理路径），
  // 位置比 clearEditable 更靠前，会让「清空在 fill 之前」误判为 false。
  // 改成比对**最后一次**出现：重试循环里那处才是要校验的。
  const clearAt = body.lastIndexOf("clearEditable(box)");
  const fillAt = body.lastIndexOf("box.fill(prompt)");
  assert.ok(clearAt >= 0, "fillVerifiedPrompt 必须先清空输入框");
  assert.ok(fillAt >= 0, "fillVerifiedPrompt 仍应调用 fill");
  assert.ok(clearAt < fillAt, "清空必须在 fill 之前 —— 顺序反了等于没清");
});

test("重试循环里每次都要重新清空", () => {
  // 关键：不只是第一次清，而是每次重试都清。
  // 若只在循环外清一次，第二次失败后残留又会出现。
  const body = functionBody("fillVerifiedPrompt");
  const loop = body.slice(body.indexOf("for (let attempt"));
  assert.ok((loop.match(/clearEditable\(/g) ?? []).length >= 1, "重试循环内必须有清空");
  assert.ok(loop.lastIndexOf("clearEditable(") < loop.lastIndexOf("box.fill("),
    "循环内清空仍需在 fill 之前");
});

test("clearEditable 处理 input/textarea 与 contenteditable 两种形态", () => {
  const fn = functionBody("clearEditable");
  assert.match(fn, /HTMLInputElement|HTMLTextAreaElement/, "要处理 input/textarea");
  assert.match(fn, /textContent\s*=\s*""/, "contenteditable 要清空内容");
  assert.match(fn, /new Event\("input"/,
    "必须派发 input 事件 —— 豆包的发送按钮靠它启用，只改 value 按钮仍是灰的");
});

test("text-lost-after-fill 记下 expected/settled 便于排查", () => {
  // 原来只记 { reason }，看不出「填进去的是什么、变成了什么」。
  // 那次排查 i28 花了很久，就是因为日志里没有这两项。
  //
  // 断言写成语义检查而非逐字匹配：诊断对象的写法改过两次
  // （加 normalizeForLog），逐字匹配在实现演进时会误报。
  const body = functionBody("fillVerifiedPrompt");
  assert.match(body, /reason: "text-lost-after-fill"/);
  assert.match(body, /expected:/, "诊断要含 expected");
  assert.match(body, /settled:/, "诊断要含 settled");
});

test("校验失败时保留 expected/actual 诊断", () => {
  // 实测能从库里读出 i28 的 expected/actual，这是定位到「输入框残留」
  // 而非「平台限流」的关键依据。删掉它下次又只能靠猜。
  //
  // 同样改成语义检查 —— 逐字匹配在诊断写法演进时会误报。
  const body = functionBody("fillVerifiedPrompt");
  assert.match(body, /reason: "verification-mismatch"/);
  assert.match(body, /expected:/);
  assert.match(body, /actual:/);
});
