/**
 * 推广弹窗的关闭契约。
 *
 * 锁的是 2026-10-06 一次真实失效（批次 2 的三条 34 秒失败）：
 * `dismissPromoDialog` 遍历 `[role="dialog"]`，而实测弹窗主体**没有这个角色**
 * （role=dialog 全页只有 1 处、aria-modal 为 0），主体是 `dialogContent-*`，
 * 遮罩是 `dialogOverlay-*`；首选的 `[data-slot="dialog-close"]` 在页面上出现 0 次。
 * 于是它遍历不到弹窗，等于什么都没做。
 *
 * 现象的完整链条（本文件要锁住的）：
 *   弹窗主体 h-full w-full（全屏）+ overlay pointer-events:auto
 *     → fill() 走 keyboard.insertText 文本通道、不经命中测试 → 文字填进去了
 *     → 点发送按钮必须过 actionability → 被全屏遮罩挡住 → tryClickSend 返回 false
 *     → 8 秒轮询 + 20 秒等确认 + 6 秒准备 ≈ 34 秒 → SUBMISSION_FAILED
 *
 * 结论写进注释而不是只写进实现：下一轮改版时，判据从「有没有那段文案」回到
 * 「有没有 role=dialog」，故障会原样复现且没有任何报错。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/doubao.js", import.meta.url), "utf8");

function bodyBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start > 0, `应能找到 ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `应能在 ${startMarker} 之后找到 ${endMarker}`);
  return source.slice(start, end);
}

function dismissBody() {
  return bodyBetween("async function dismissPromoDialog", "\nasync function submitPrompt");
}

test("弹窗判据按文案而不是 role=dialog（实测主体没有该角色）", () => {
  const body = dismissBody();
  // 不再以 querySelectorAll('[role="dialog"]') 作为「有没有弹窗」的判据
  assert.doesNotMatch(
    body,
    /querySelectorAll\('\[role="dialog"\]'\)\.length/,
    "不能用 role=dialog 计数当存在性判据 —— 实测弹窗主体没有这个角色",
  );
  assert.match(body, /PROMO_DIALOG_TEXT\.source/, "应按推广文案判存在性");
});

test("三条关闭路径都要在：关闭控件 → 点遮罩 → Escape", () => {
  const body = dismissBody();
  assert.match(body, /dialog-close/, "① 首选关闭控件（即便实测缺失，保留以适配改版）");
  assert.match(body, /dialog-overlay/, "② 点遮罩本体");
  assert.match(body, /keyboard\.press\("Escape"\)/, "③ Escape 兜底");
  // 顺序不能反：先找控件再退化
  const idxClose = body.indexOf("dialog-close");
  const idxOverlay = body.indexOf("dialog-overlay");
  const idxEscape = body.indexOf('keyboard.press("Escape")');
  assert.ok(idxClose < idxOverlay, "关闭控件应先于点遮罩");
  assert.ok(idxOverlay < idxEscape, "点遮罩应先于 Escape");
});

test("弹窗清理必须发生两次（填入前 + 填入后）", () => {
  const body = bodyBetween("async function submitPrompt", "\nasync function finishSubmit");
  const clears = body.match(/dismissPromoDialog\(page\)/g) ?? [];
  assert.ok(
    clears.length >= 2,
    `fillVerifiedPrompt 前后各清一次 —— 实测弹窗会在填入过程中弹出，只清开头那次拦不住。实测 ${clears.length} 次`,
  );
  const fillIdx = body.indexOf("fillVerifiedPrompt");
  const firstClear = body.indexOf("dismissPromoDialog");
  const secondClear = body.indexOf("dismissPromoDialog", firstClear + 1);
  assert.ok(firstClear < fillIdx, "第一次清理应在填入之前");
  assert.ok(secondClear > fillIdx, "第二次清理应在填入之后");
});

test("点不到按钮时清弹窗并重试点按钮，而不是直接落 Enter", () => {
  const body = bodyBetween("async function submitPrompt", "\nasync function finishSubmit");

  // 用结构断言而不是字符位置断言：函数体内的注释里同样出现 tryClickSend /
  // press("Enter") 这些词，按位置比较会被注释干扰（这个断言已经因此失败过三轮）。
  //
  // 要锁的是**分支结构**：`if (!sentByButton)` 里必须先清弹窗再重试点按钮，
  // 且 Enter 兜底必须落在同一个 if 分支内、重试点按钮之后。
  const guardIdx = body.indexOf("if (!sentByButton) {");
  assert.ok(guardIdx > 0, "应存在 sentByButton 为假的兜底分支");

  const branch = body.slice(guardIdx);
  // 逐个用 indexOf 而不是 search —— 正则里 (page) 是捕获组、press("Enter") 带参数，
  // 这两处一旦漏转义就永远匹配不到（这个断言已经因此反复失败）。
  const clearIdx = branch.indexOf("await dismissPromoDialog(page)");
  const retryIdx = branch.indexOf("await tryClickSend(page)");
  const enterIdx = branch.indexOf('press("Enter"');
  assert.ok(clearIdx >= 0, "分支内应清弹窗");
  assert.ok(retryIdx > clearIdx, "清完弹窗应重试点按钮");
  assert.ok(enterIdx > retryIdx, "Enter 是最后兜底，不该抢在重试点按钮之前");
  assert.match(branch, /finishSubmit/, "重试成功应走同一个提交确认逻辑");
});

test("机制与实测结论写进注释（避免被当成过度实现改回去）", () => {
  // 实测结论写在函数上方的 JSDoc 里（JSDoc 才是给人读的），实现体内只留简短指引。
  const jsdocStart = source.lastIndexOf("/**", source.indexOf("async function dismissPromoDialog"));
  const jsdoc = source.slice(jsdocStart, source.indexOf("async function dismissPromoDialog"));
  assert.ok(jsdoc.length > 400, "dismissPromoDialog 上方应有成段的说明");
  assert.match(jsdoc, /0\s*次/, "应记录 dialog-close 实测出现 0 次");
  assert.match(jsdoc, /h-full w-full/, "应记录弹窗是 h-full w-full 全屏而非浮层");
  assert.match(jsdoc, /insertText/, "应记录 fill 不经命中测试这一关键差异");
  assert.match(jsdoc, /34\s*秒/, "应记录 34 秒这个实测耗时，它是本次修复的判据之一");
});