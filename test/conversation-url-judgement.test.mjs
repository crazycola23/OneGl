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
 * 因为会话 id 才是「平台接收了这条提问」的直接证据。
 *
 * ── 2026-10-06 修正：会话 id 有三种形态，不是两种 ──────────────────
 * 上面那句「`/chat/local_<id>` 才是直接证据」当时是错的 ——
 * 实测 24 条成功条目用的全是**纯数字** id：
 *
 *   /chat/38445659053922818          ← 成功的那些
 *   /chat/local_9672152282099622     ← 失败时的 error_details.url
 *   /chat/c_xxxxxxxx
 *
 * 原实现只匹配 `local_` / `c_` 前缀，于是成功的会话页被归一化成
 * `page:/chat`，与 chat 根页 `page:/chat` **判成同一个** ——
 * URL 判据对数字 id 完全失效，而它本该是那条最可靠的证据。
 *
 * 后果实测（.ops/confirm-session-rootpage.sh，六批 52 条）：
 *
 *   停在根页 /chat/?from_logout=1   19 条   有答案 0 条   最长答案 0 字
 *   进了会话页 /chat/{id}           33 条   有答案 24 条   最长答案 1701 字
 *
 * 19 条「从未建会话」的失败白等 180 秒（≈57 分钟），
 * 且被误判成提交成功（conversationResetConfirmed=true）。
 *
 * 所以现在的判据是**形态**（末段像不像 id），不是前缀。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConversationUrl, conversationUrlChanged, conversationIdOf } from "../src/doubao.js";

test("★ 纯数字会话 id 也算会话（原实现把它与根页判成同一个）", () => {
  // 2026-10-06 实测：24 条成功条目的 URL 全是这个形态
  //   https://www.doubao.com/chat/38445659053922818
  // 而原实现只匹配 local_ 与 c_ 前缀，于是它被归一化成 page:/chat，
  // 与 chat 根页 page:/chat **判成同一个** ——
  // 「URL 变了」这个判据对数字 id 完全失效。
  //
  // 后果不是理论上的：19 条「从未建会话」的失败白等了 180 秒，
  // 且被误判成提交成功（conversationResetConfirmed=true）。
  const rootUrl = "https://www.doubao.com/chat/?from_logout=1";
  const numericUrl = "https://www.doubao.com/chat/38445659053922818";

  assert.notEqual(
    normalizeConversationUrl(rootUrl),
    normalizeConversationUrl(numericUrl),
    "根页与数字 id 会话页必须归一化成不同的东西，否则 URL 判据失效",
  );
  assert.match(normalizeConversationUrl(numericUrl), /^conversation:/, "数字 id 应当被认作会话");
  assert.match(normalizeConversationUrl(rootUrl), /^page:/, "根页不应当被认作会话");
  assert.equal(
    conversationUrlChanged(rootUrl, numericUrl),
    true,
    "从根页进入会话页应当算「平台接收了这条提问」",
  );
  // ⚠️ 入参必须是**原始 URL**，不是归一化后的串。
  //    传 `page:/chat` 会走 catch 分支变成 `raw:page:/chat`，
  //    于是不满足 `after.startsWith("conversation:")` → false。
  //    我写这条测试时先踩了这个坑。
});

test("会话 id 的三种形态都要认得", () => {
  for (const url of [
    "https://www.doubao.com/chat/local_9672152282099622",
    "https://www.doubao.com/chat/c_abcdef123456",
    "https://www.doubao.com/chat/38445659053922818",
  ]) {
    assert.match(
      normalizeConversationUrl(url),
      /^conversation:/,
      `应认得这种会话 id：${url}`,
    );
  }
});

test("根页的各种写法都不是会话", () => {
  for (const url of [
    "https://www.doubao.com/chat/",
    "https://www.doubao.com/chat",
    "https://www.doubao.com/chat/?from_logout=1",
    "https://www.doubao.com/chat/?from_logout=1&x=2",
    "https://www.doubao.com/",
  ]) {
    assert.match(
      normalizeConversationUrl(url),
      /^page:/,
      `不该把根页认成会话：${url}`,
    );
  }
});

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