/**
 * 「页面水合」与「输入框存在」必须分开等。
 *
 * 锁的是 2026-10-06 一次真实失败（批次 4 的 run_b4_i6）：
 * 截图是骨架屏（灰色占位块、无推荐话题、无工具栏），21 秒后 UNKNOWN_ERROR。
 *
 * 实测四轮（.ops/probe-hydration.mjs）：
 *   新对话按钮可见   2.6–4.6 秒
 *   textarea 出现    7.0–11.1 秒   ← 骨架屏里已经占位
 *   整页就绪        13.3–14.7 秒   ← React 水合完成
 *
 * 而 waitForTextbox 只等「textarea 存在」，于是它在 7–11 秒就返回 ——
 * 那时页面还不可用，后续 fill / click 全部落空。
 *
 * 判据用「body.innerText 长度稳定 + 绝对下限」而不是匹配某句中文：
 * 首页有「有什么我能帮你的吗」但会话页没有，用文案会漏掉会话页。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/doubao.js", import.meta.url), "utf8");

test("必须存在独立的「等水合」函数，不能只等输入框", () => {
  assert.match(
    source,
    /async function waitForHydration/,
    "应有 waitForHydration —— 「输入框存在」不等于「页面能用」",
  );
});

test("水合判据用文本量稳定 + 绝对下限，不用文案匹配", () => {
  const start = source.indexOf("async function waitForHydration");
  const body = source.slice(start, source.indexOf("\n}", start));

  assert.match(body, /innerText/, "应读 body.innerText 的长度");
  assert.match(body, /length\s*>\s*200/, "应有绝对下限，排除骨架屏里那点固定文本也「稳定」");
  assert.match(
    body,
    /REQUIRED_STABLE_POLLS\s*=\s*3/,
    "应要求连续 3 次持平才判稳 —— 并发下 CPU 被分摊，2 次会把采样间隙误判成就绪",
  );
  assert.match(body, /stablePolls\s*>=\s*REQUIRED_STABLE_POLLS/, "判稳阈值应引用常量");
  assert.doesNotMatch(
    body,
    /有什么我能帮你的吗/,
    "不能靠首页文案判水合 —— 会话页没有这句，会误判成永远没水合",
  );
});

test("水合上限要容得下并发下的真实耗时（单跑 13–15s 不代表并发）", () => {
  const start = source.indexOf("const HYDRATION_WAIT_MS");
  const body = source.slice(start, source.indexOf("\n})();", start));
  // 批次 6 实测：两个浏览器同时跑时 30 秒不够，日志出现
  // 「页面未在 30000ms 内完成水合」—— 单跑时的 13–15 秒是独占 CPU 的数据
  assert.match(
    body,
    /return 60_000/,
    "默认上限应为 60 秒 —— 30 秒在并发下不够，而多等 20 秒不影响吞吐",
  );
  const jsdocStart = source.lastIndexOf("/**", start);
  const jsdoc = source.slice(jsdocStart, start);
  assert.match(
    jsdoc,
    /批次 6|并发/,
    "应记录「单跑数据不代表并发」这个教训，否则会被当成随手调大的等待",
  );
});

test("openDoubao 必须等水合，不能只等 composer", () => {
  const start = source.indexOf("export async function openDoubao");
  const body = source.slice(start, source.indexOf("\n/**", start + 10));
  const hydrationIdx = body.indexOf("waitForHydration");
  const textboxIdx = body.indexOf("waitForTextbox");
  assert.ok(hydrationIdx >= 0, "openDoubao 应调用 waitForHydration");
  assert.ok(textboxIdx >= 0, "openDoubao 应调用 waitForTextbox");
  assert.ok(
    hydrationIdx < textboxIdx,
    "先等水合再等输入框 —— 顺序反了等于只在骨架屏里等 textarea",
  );
});

test("startCleanConversation 也要等水合（点新对话之前页面是空的）", () => {
  const start = source.indexOf("export async function startCleanConversation");
  const body = source.slice(start, source.indexOf("\n  const byTestId", start + 10));
  assert.match(
    body,
    /waitForHydration/,
    "点「新对话」前应等水合：按钮在 2.6 秒就可见但事件处理器要等水合才挂上",
  );
});

test("水合等待超时不抛错，交给下游 fail-closed（不改变错误语义）", () => {
  // 精确截取函数体：从 `async function waitForHydration` 到它自己的收尾大括号，
  // 不能用「下一个 async function」当边界 —— waitForHydration 后面紧跟的是
  // 常量 HYDRATION_WAIT_MS 再接 openDoubao（那里有 throw），会把它的 throw 圈进来。
  const start = source.indexOf("async function waitForHydration");
  const end = source.indexOf("\n}", start);
  const body = source.slice(start, end);
  assert.match(body, /return false/, "超时应返回 false 而不是 throw");
  assert.doesNotMatch(body, /throw /, "水合等待本身不应抛异常");
});

test("实测数字写进注释，避免被当成随手加的等待调小", () => {
  const start = source.indexOf("async function waitForHydration");
  const jsdocStart = source.lastIndexOf("/**", start);
  const jsdoc = source.slice(jsdocStart, start);
  assert.match(jsdoc, /13\.3|13–14|整页就绪/, "应记录整页就绪的实测区间");
  assert.match(jsdoc, /骨架屏/, "应记录失败时页面是骨架屏这一事实");
  assert.match(jsdoc, /sessionSignals|会话页|会话页/, "应记录为什么不用文案匹配");
});