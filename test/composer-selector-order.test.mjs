/**
 * composer 选择器链的排序契约。
 *
 * 锁的是一次真实故障（2026-10-05）：把 `textarea[data-testid="chat_input_input"]`
 * 提到首位后，startCleanConversation 在点击新对话之后卡死 15 秒超时。
 *
 * 机制（.ops/probe-composer-shape.mjs 实测）：豆包的 composer 是**同一个输入框的两种
 * 实现、点击时切换**，不是两个编辑器并存：
 *   首屏   → textarea 可见可编辑；ProseMirror visibility:hidden
 *   点击后 → textarea 从 DOM 移除（count 0）；ProseMirror 变可见可编辑
 *
 * 而 textarea 根本没有 data-testid="chat_input_input"，所以那条具体形态选择器
 * 从一开始就不成立。结论是排序原则应为**通用形态优先、具体形态兜底**，
 * 让链对「点过 composer」和「没点过」两种页面状态都成立。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/doubao.js", import.meta.url), "utf8");

function selectorChain() {
  const start = source.indexOf("const selectors = [", source.indexOf("async function firstVisibleEditable"));
  assert.ok(start > 0, "应能找到 firstVisibleEditable 的选择器链");
  const open = source.indexOf("[", start);
  const close = source.indexOf("];", open);
  return [...source.slice(open + 1, close).matchAll(/"([^"]+)"|'([^']+)'/g)]
    .map((m) => m[1] ?? m[2]);
}

test("通用形态必须排在具体形态之前", () => {
  const chain = selectorChain();
  const indexOf = (sel) => chain.indexOf(sel);

  const genericTextarea = indexOf("textarea");
  const genericEditable = indexOf('[contenteditable="true"]');
  const specificTextarea = indexOf('textarea[placeholder*="发消息"]');
  const specificTiptap = indexOf('.tiptap.ProseMirror[contenteditable="true"]');

  assert.ok(genericTextarea >= 0, "链里必须有通用 textarea");
  assert.ok(genericEditable >= 0, "链里必须有通用 contenteditable（点击后的形态）");

  if (specificTextarea >= 0) {
    assert.ok(
      genericTextarea < specificTextarea,
      `通用 textarea 应排在具体形态之前：${chain.join(" → ")}`,
    );
  }
  if (specificTiptap >= 0) {
    assert.ok(
      genericEditable < specificTiptap,
      `通用 contenteditable 应排在 tiptap 之前：${chain.join(" → ")}`,
    );
  }
});

test("不得依赖 textarea 带 data-testid=chat_input_input（实测它没有）", () => {
  const chain = selectorChain();
  assert.ok(
    !chain.includes('textarea[data-testid="chat_input_input"]'),
    "实测 textarea 根本没有这个 testid，把它放首位会让点击后的页面状态整条链查空",
  );
});

test("链上必须同时能覆盖两种页面状态（首屏 textarea / 点击后 contenteditable）", () => {
  const chain = selectorChain();
  const coversIdle = chain.includes("textarea");
  const coversFocused = chain.includes('[contenteditable="true"]');
  assert.ok(coversIdle, "必须能匹配首屏的 textarea");
  assert.ok(coversFocused, "必须能匹配点击后的 ProseMirror（contenteditable）");
});

test("机制与实测结论写进注释，避免又被当成随手排序改回去", () => {
  const start = source.indexOf("async function firstVisibleEditable");
  const block = source.slice(start, start + 2200);
  assert.match(block, /visibility:\s*hidden/, "应记录首屏 ProseMirror 不可见的观测");
  assert.match(block, /从 DOM 移除|count 0/, "应记录点击后 textarea 被移除这一事实");
  assert.match(block, /通用形态优先/, "应写明排序原则");
});