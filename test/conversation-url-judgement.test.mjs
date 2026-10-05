/**
 * URL 形态判据的契约 —— 锁住「URL 变了 ≠ 提交成功」这个教训。
 *
 * 2026-10-06 实测（.ops/probe-url-jitter.mjs）：豆包会自己把
 * `/chat/` 改写成 `/chat`（少尾斜杠），也会附加 `?from_logout=1`，
 * **两者都与提交无关**。而原实现用裸比较判「URL 变了 = 提交成功」，
 * 于是 `/chat/` → `/chat` 就返回 true，把「压根没发出去」记成「已提交」，
 * 随后 180 秒等不到答案 → ANSWER_NOT_FOUND。
 *
 * 实测与失败的强相关（批次 1）：
 *   failed 3 → from_logout=1 命中 3 次
 *   success 3 → from_logout=1 命中 0 次
 *
 * 归一化后唯一认可的形态变化是「非会话页 → 会话页」，
 * 因为 `/chat/local_<id>` 才是「平台接收了这条提问」的直接证据。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConversationUrl, conversationUrlChanged } from "../src/doubao.js";

test("尾斜杠差异不算「换了会话」（实测豆包会自己归一化）", () => {
  const slash = "https://www.doubao.com/chat/";
  const noSlash = "https://www.doubao.com/chat";
  assert.equal(
    normalizeConversationUrl(slash),
    normalizeConversationUrl(noSlash),
    "/chat/ 与 /chat 是同一个页面",
  );
  assert.equal(
    conversationUrlChanged(slash, noSlash),
    false,
    "尾斜杠抖动不能被判成提交成功 —— 这正是那三条 ANSWER_NOT_FOUND 的成因",
  );
});

test("from_logout 重定向不算「换了会话」", () => {
  const base = "https://www.doubao.com/chat/";
  assert.equal(
    conversationUrlChanged(base, "https://www.doubao.com/chat/?from_logout=1"),
    false,
    "登出重定向与提交无关（实测 3 条失败全部带它，3 条成功全部不带）",
  );
});

test("出现 /chat/local_<id> 才算提交成功", () => {
  const base = "https://www.doubao.com/chat/";
  const withConv = "https://www.doubao.com/chat/local_1707822942163671";
  assert.equal(
    conversationUrlChanged(base, withConv),
    true,
    "会话 id 出现是「平台接收了这条提问」最直接的证据",
  );
});

test("会话 id 变化才算换会话（同一路径不同 id）", () => {
  const a = "https://www.doubao.com/chat/local_111";
  const b = "https://www.doubao.com/chat/local_222";
  assert.equal(conversationUrlChanged(a, b), true, "不同会话 id 是换了对话");
  assert.equal(conversationUrlChanged(a, a), false, "同一个会话不算变化");
});

test("反向变化（会话页 → 非会话页）不算提交成功", () => {
  // 点「新对话」会把会话页退回首页，这是清会话、不是提交。
  assert.equal(
    conversationUrlChanged("https://www.doubao.com/chat/local_111", "https://www.doubao.com/chat/"),
    false,
    "退回首页是清会话，方向不对",
  );
});

test("空值与非法 URL 不产生误判", () => {
  assert.equal(conversationUrlChanged("", "https://www.doubao.com/chat/local_1"), false);
  assert.equal(conversationUrlChanged("https://www.doubao.com/chat/", ""), false);
  assert.equal(conversationUrlChanged("not a url", "also not a url"), false);
  assert.equal(normalizeConversationUrl(""), "");
});

test("查询参数与 hash 不参与判定", () => {
  const base = "https://www.doubao.com/chat/";
  assert.equal(
    conversationUrlChanged(base, "https://www.doubao.com/chat/?utm_source=x"),
    false,
    "营销参数不该被当成换会话",
  );
  assert.equal(
    conversationUrlChanged(base, "https://www.doubao.com/chat/#anchor"),
    false,
  );
});