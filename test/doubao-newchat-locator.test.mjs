/**
 * 新对话按钮的定位契约。
 *
 * 这组用例锁的是一次真实缺陷（服务器探针实测，2026-10-05）：
 * 豆包新对话按钮的**可访问名是「新对话 Ctrl Shift K」** —— 快捷键提示是按钮内的兄弟
 * 文本节点，不在 title / aria-label 上。于是：
 *   - `getByRole("button", { name: "新对话", exact: true })` 必然落空；
 *   - `getByText("新对话", { exact: true })` 命中的是不可点的外层 div，点下去不触发。
 * 兜底因此退回 openDoubao 重开首页、停在裸根路径 `/chat/`，页面状态不完整，
 * 发送按钮不渲染，最后落回 Enter 提交 —— 一条链上的三个症状。
 *
 * 修法用的是 testid：`create_conversation_button` 是外层容器，可点击本体在其内部，
 * 是 `div[role=button]`。语义定位降级为兜底。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { startCleanConversation, assertFreshConversation } from "../src/doubao.js";
import { ErrorCode } from "../src/errors.js";

/**
 * 造一个最小 page 替身。
 *
 * 只实现被调用到的方法：locator / getByRole / getByText / waitForTimeout /
 * url。startCleanConversation 末尾会 waitForTextbox + waitForEmptyConversation，
 * 这里让它们立刻满足，聚焦在「点了哪个元素」。
 */
function makePage({ byTestId = [], roleMatches = [], textMatches = [], answerCount = 0 } = {}) {
  const clicks = [];
  const locatorCalls = [];
  // roleCalls 单独记 getByRole 的**原始参数**（不 JSON 化）——
  // JSON.stringify(/^新对话/) 得到 {}，断言会看不到正则，只能拿到空对象。
  const roleCalls = [];

  const makeLocator = (selector, matcher) => ({
    selector,
    async count() {
      return matcher.length;
    },
    nth(index) {
      return {
        selector,
        index,
        async isVisible() {
          return index < matcher.length;
        },
        async isEditable() {
          return index < matcher.length;
        },
        async click() {
          // 记录**被点的那个节点自己**的选择器。nth() 的闭包里 selector 是外层的，
          // 所以用 this/自身闭包显式带上 nth 所在的那一层 —— 真实 Playwright 里
          // 点的是 nth 取出来的那个元素，即容器内的 role=button，而不是容器。
          clicks.push({ via: `${selector} >> nth(${index})`, index });
        },
        // waitForTextbox 返回的是 nth() 出来的这个子对象，不是外层 locator，
        // 所以 fill/press 必须挂在这里 —— startCleanConversation 拿到 box 后会 fill("")。
        async fill() {},
        async press() {},
        async click_() {},
      };
    },
    locator(childSelector) {
      locatorCalls.push(`${selector} >> ${childSelector}`);
      return makeLocator(`${selector} >> ${childSelector}`, matcher);
    },
    async isVisible() {
      return matcher.length > 0;
    },
    async fill() {},
    async press() {},
  });

  // composer：firstVisibleEditable 按选择器顺序找「可见且可编辑」的节点。
  // startCleanConversation 拿到它之后会 fill("")，所以这里必须给一个能过的替身，
  // 否则 waitForTextbox 会空转到 30 秒超时（测试挂住，而不是失败）。
  const composerLocator = makeLocator(".tiptap.ProseMirror[contenteditable=\"true\"]", ["box"]);

  const page = {
    url: () => "https://www.doubao.com/chat/local_123",
    clicks,
    locatorCalls,
    roleCalls,
    locator: (selector) => {
      locatorCalls.push(selector);
      if (selector.includes('ProseMirror[contenteditable="true"]')) return composerLocator;
      const matcher =
        selector.includes("create_conversation_button")
          ? byTestId
          : selector.includes("新对话")
            ? roleMatches
            : [];
      return makeLocator(selector, matcher);
    },
    getByRole(role, options) {
      roleCalls.push({ role, options });
      locatorCalls.push(`getByRole(${role})`);
      return makeLocator(`getByRole:${role}`, roleMatches);
    },
    getByText(text) {
      locatorCalls.push(`getByText(${text})`);
      return makeLocator(`getByText:${text}`, textMatches);
    },
    async waitForTimeout() {},
    // answerCandidates：非空表示会话里还有上一问的答案 —— waitForEmptyConversation
    // 就是靠它判 resetConfirmed。给一个稳定的非空数组（不会被清空）。
    async evaluate(callback) {
      const source = String(callback);
      // 页面已就绪；定位测试不应等待真实的水合超时。
      if (source.includes("composerReady") && source.includes("textLength")) {
        return { textLength: 64, composerReady: true, covered: false };
      }
      if (source.includes("md-box-root")) {
        return Array.from({ length: answerCount }, (_, i) => ({ innerText: `上一问答案${i}` }));
      }
      return [];
    },
  };
  return page;
}

const emptyConfig = { conversationSettleMs: 0 };

test("新对话走 testid 容器内的 role=button（实测形态：可访问名带快捷键后缀）", async () => {
  const page = makePage({ byTestId: ["container"] });
  const result = await startCleanConversation(page, emptyConfig);

  assert.equal(result.clickedNewConversation, true, "必须真的点到，不能静默降级");
  assert.equal(page.clicks.length, 1, "只该点一次");
  // 关键：走的是 testid 路径，且点的是容器内部的 role=button（可点击本体），
  // 不是不可点的外层容器 div。
  assert.ok(
    page.clicks[0].via.startsWith('[data-testid="create_conversation_button"] >> [role="button"]'),
    `实际点到的是 ${page.clicks[0].via}`,
  );
});

test("testid 容器内无可点子节点时，退回点容器本身", async () => {
  // byTestId 有值 → testid 路径命中，clicked=true，不会进入语义兜底。
  // 断言的是「先试子、再试容器」这个顺序（用 locator 记录复现）。
  const page = makePage({ byTestId: ["container"] });
  await startCleanConversation(page, emptyConfig);

  // locator() 先记录自身选择器，再记录 .locator() 的子选择器，
  // 所以「取容器」排在「取容器内的 role=button」之前。断言的是这个取用顺序。
  const containerIdx = page.locatorCalls.indexOf('[data-testid="create_conversation_button"]');
  const childIdx = page.locatorCalls.indexOf(
    '[data-testid="create_conversation_button"] >> [role="button"]',
  );
  assert.ok(containerIdx >= 0, `应先取容器：${page.locatorCalls.join(" | ")}`);
  assert.ok(childIdx > containerIdx, `应紧接着取容器内的 role=button：${childIdx} vs ${containerIdx}`);
  // 且实际点到的是子节点。
  assert.ok(page.clicks[0].via.includes('[role="button"]'));
});

test("testid 缺失时回落到非精确语义定位，覆盖「新对话 Ctrl Shift K」", async () => {
  // byTestId 为空 → testid 路径点不到 → 必须进入语义兜底。
  // roleMatches 只喂给 getByRole，testid 路径拿不到它，两条路径被真正分开。
  const page = makePage({ byTestId: [], roleMatches: ["新对话 Ctrl Shift K"] });
  const result = await startCleanConversation(page, emptyConfig);

  assert.equal(result.clickedNewConversation, true, "语义兜底应成功");
  // 断言原始参数而不是序列化字符串：正则 JSON 化后是 {}。
  const regexAttempt = page.roleCalls.find(
    (call) => call.options?.name instanceof RegExp,
  );
  assert.ok(regexAttempt, "必须尝试正则形态的可访问名匹配");
  assert.match(String(regexAttempt.options.name.source), /新对话/);
});

test("不再使用 exact:true 的语义定位（那正是失效的那条）", async () => {
  const page = makePage({ byTestId: ["container"] });
  await startCleanConversation(page, emptyConfig);
  const exactAttempts = page.locatorCalls.filter((c) => c.includes('"exact":true'));
  assert.equal(
    exactAttempts.length,
    0,
    `exact:true 精确匹配必然匹配不到带快捷键后缀的可访问名：${exactAttempts.join(" | ")}`,
  );
});

test("全部候选都不可点时，clickedNewConversation 为 false（由上层 fail-closed 处理）", async () => {
  const page = makePage({ byTestId: [], roleMatches: [], textMatches: [] });
  const result = await startCleanConversation(page, emptyConfig);
  assert.equal(result.clickedNewConversation, false);
});

test("定位层抛异常必须降级成「没点到」，而不是冒泡成 UNKNOWN_ERROR", async () => {
  const page = makePage({ byTestId: [], roleMatches: [], textMatches: [] });
  const originalLocator = page.locator;
  page.locator = (selector) => {
    // 容器不支持 .locator()：只有 count，且 count 本身就抛。
    if (selector.includes("create_conversation_button")) {
      page.locatorCalls.push(selector);
      return {
        async count() {
          throw new TypeError("locator.locator is not a function");
        },
      };
    }
    return originalLocator(selector);
  };

  const result = await startCleanConversation(page, emptyConfig);
  assert.equal(
    result.clickedNewConversation,
    false,
    "定位异常应降级为 false，交给上层 fail-closed，而不是抛出",
  );
});

/**
 * 坐标点击兜底：locator.click() 死等 actionability 时的最后一招。
 *
 * 2026-10-05 实测（.ops/probe-two-turns.mjs）：豆包侧栏有 2 个同名
 * `create_conversation_button` 容器，内层 role=button 与外层容器的 click() 都
 * Timeout 6000ms，而 page.mouse.click(中心坐标) 立刻生效。
 */
test("locator.click 死等时改用坐标点击（实测唯一能穿过 actionability 的手法）", async () => {
  const page = makePage({ byTestId: [], roleMatches: [], textMatches: [] });
  const originalLocator = page.locator;

  page.mouseClicks = [];
  page.mouse = {
    async click(x, y) {
      page.mouseClicks.push({ x, y });
    },
  };

  page.locator = (selector) => {
    // 新对话容器：可见、有几何位置，但 click() 永远超时（模拟 actionability 陷阱）。
    if (selector.includes("create_conversation_button")) {
      page.locatorCalls.push(selector);
      return {
        async count() {
          return 1;
        },
        nth: () => ({
          async isVisible() {
            return true;
          },
          async boundingBox() {
            return { x: 13, y: 89, width: 254, height: 34 };
          },
          async click() {
            throw new Error("locator.click: Timeout 5000ms exceeded");
          },
        }),
      };
    }
    return originalLocator(selector);
  };

  const result = await startCleanConversation(page, emptyConfig);
  assert.equal(result.clickedNewConversation, true, "坐标点击应被记为已点击");
  assert.equal(page.mouseClicks.length, 1, "应恰好做了一次坐标点击");
  assert.deepEqual(
    page.mouseClicks[0],
    { x: 13 + 254 / 2, y: 89 + 34 / 2 },
    "应点在元素几何中心",
  );
});

test("resetConfirmed 为假时 clickedNewConversation 不许冒充成功（可见性污染闸门）", async () => {
  // 点发出去了，但会话没清空 —— 实测坐标点击后 chatId 不变、答案区仍在。
  // 这是「一问一换对话」契约被破坏的时刻：clicked=true 不能被当成成功。
  const page = makePage({ byTestId: ["container"], answerCount: 1 });
  const result = await startCleanConversation(page, emptyConfig);

  assert.equal(result.clickedNewConversation, true, "点击确实发出去了");
  assert.equal(
    result.resetConfirmed,
    false,
    "会话里有残留答案时 resetConfirmed 必须为 false",
  );
  assert.ok(
    "conversationUrl" in result,
    "应带 conversationUrl，供上层对比点击前后的会话标识",
  );
});

test("assertFreshConversation 只认 resetConfirmed：点了但没清空就 fail-closed", async () => {
  // 这一条锁的是采集契约本身：会话没清空就提问，问出来的是对上一问的追问，
  // 可见性维度被污染且从报告里分辨不出来。所以必须拒绝发送。
  assert.throws(
    () => assertFreshConversation(
      { clickedNewConversation: true, resetConfirmed: false },
      "https://www.doubao.com/chat/local_123",
    ),
    (error) => {
      assert.equal(error.code, ErrorCode.CONVERSATION_RESET_FAILED);
      assert.equal(error.details.promptSubmitted, false, "必须声明没提交，避免重复提问");
      assert.equal(error.details.clickedNewConversation, true, "保留「点了但没生效」的现场");
      return true;
    },
  );
});

test("resetConfirmed 为真时放行", () => {
  assert.doesNotThrow(() =>
    assertFreshConversation({ clickedNewConversation: true, resetConfirmed: true }, "u"),
  );
});
