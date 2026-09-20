/**
 * 登录浮层可达性回归测试（2026-09-20）。
 *
 * 背景：GEO 端扫码登录看不到二维码。排查链：
 *   ① OneGl 的 inspectSession 把匿名也会下发 CSRF cookie 当登录凭证 ⇒ 已修（见
 *      test/doubao-session-inspection.test.mjs）；
 *   ② 修完①后会话能停在 waiting_for_login，但截图里仍无二维码 —— 根因是
 *      openLoginSurface 只要「点击未抛错」就 return，不校验浮层是否真的打开、
 *      二维码是否真的渲染。真实浏览器实测点击后浮层文本为
 *      「使用豆包或飞书账号登录 … 打开 豆包 / 飞书 App 扫码登录」，
 *      二维码容器为 div[class*="qrcode"]（实测 164x162）。
 *
 * 本文件用 mock page 驱动 openLoginSurface 的对外行为，锁死三件事：
 *   1. 点击后浮层未出现 ⇒ openLoginSurface 必须重试后续候选，而不是直接返回；
 *   2. 浮层出现但二维码慢一拍 ⇒ 必须等到二维码可见才返回；
 *   3. 已是 healthy 会话 ⇒ 不应点击任何按钮（不打扰已登录页面）。
 */

import test from "node:test";
import assert from "node:assert/strict";

// openLoginSurface 是模块内私有函数，通过导出再测会污染公共 API，
// 因此这里改为「按源码语义重建最小可测单元」的等价验证：
// 直接从模块源码中提取 openLoginSurface，用 vm 在同一作用域内执行。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "..", "src", "api", "remote-auth.js"), "utf8");

function extractFunction(name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `源码中找不到 ${name}`);
  // 用花括号配平切出函数体（忽略字符串内的花括号足够用于本文件）。
  let depth = 0;
  let index = source.indexOf("{", start);
  const bodyStart = index;
  for (; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return source.slice(start, index + 1);
}

const openLoginSurfaceSource = extractFunction("openLoginSurface");
const loginSurfaceVisibleSource = extractFunction("loginSurfaceVisible");

function buildOpenLoginSurface(inspectSessionImpl) {
  const context = {
    inspectSession: inspectSessionImpl,
    // 测试替身：把 evaluate 当成「执行页面内探针」的入口。
    console,
  };
  vm.createContext(context);
  vm.runInContext(`${loginSurfaceVisibleSource}\n${openLoginSurfaceSource}`, context);
  return { openLoginSurface: context.openLoginSurface };
}

/**
 * 构造 mock page。
 * @param {object} spec
 * @param {object[]} spec.buttons      候选按钮，每项 { visible, clickOpens } 
 * @param {object}   spec.probe        浮层探测结果轮询序列
 */
/**
 * 构造 mock page。
 *
 * 每个候选按钮支持下列行为（对应源码里「force click → dispatchEvent 兜底」两步）：
 *   clickForcedFails  : force click 抛错（模拟节点真的点不动）
 *   dispatchFails     : dispatchEvent 也抛错
 *   plainClickWorks   : 仅当 force 被跳过时可用（用于回归「必须带 force」）
 */
function createMockPage(spec) {
  const calls = { clicks: 0, clicksOn: [], forced: 0, dispatched: 0 };
  let probeIndex = 0;

  const makeLocator = (list) => ({
    async count() {
      return list.length;
    },
    nth(index) {
      return list[index];
    },
  });

  const buttonLocators = spec.buttons.map((button) =>
    makeLocator([
      {
        async isVisible() {
          return button.visible !== false;
        },
        async click(options = {}) {
          calls.clicks += 1;
          calls.clicksOn.push(button.name);
          if (options.force) {
            calls.forced += 1;
            if (button.clickForcedFails) throw new Error("still covered");
            return undefined;
          }
          // 不带 force 的点击：camoufox 下会超时（模拟真实失败）。
          if (button.forceRequired !== false) throw new Error("Timeout 5000ms exceeded");
          return undefined;
        },
        async dispatchEvent() {
          calls.dispatched += 1;
          if (button.dispatchFails) throw new Error("dispatch failed");
          return undefined;
        },
      },
    ]),
  );

  const page = {
    calls,
    getByRole() {
      return buttonLocators[0] ?? makeLocator([]);
    },
    getByText() {
      return buttonLocators[1] ?? makeLocator([]);
    },
    async waitForTimeout() {},
    async evaluate() {
      const probe = spec.probes[Math.min(probeIndex, spec.probes.length - 1)];
      probeIndex += 1;
      return probe;
    },
  };
  return page;
}

test("浮层未出现时必须继续尝试后续候选，而不是点一次就返回", async () => {
  // 第一个候选点了没反应（浮层始终不出现），第二个候选能打开浮层。
  // 探针按「每次点击后最多探测 15 次」消费：
  //   候选1 → 15 次全 false
  //   候选2 → 第 2 次探测即 ok
  const falseProbe = { overlayPresent: false, qr: false, hint: false, ok: false };
  const okProbe = { overlayPresent: true, qr: true, hint: true, ok: true };
  const page = createMockPage({
    buttons: [
      { name: "role-登录", clickForcedFails: true, dispatchFails: true },
      { name: "text-登录" },
    ],
    probes: [
      ...Array.from({ length: 15 }, () => falseProbe),
      falseProbe,
      okProbe,
    ],
  });

  const { openLoginSurface } = buildOpenLoginSurface(async () => ({ state: "unknown" }));
  await openLoginSurface(page);

  assert.deepEqual(
    page.calls.clicksOn,
    ["role-登录", "text-登录"],
    `浮层未出现时应重试后续候选，实际点击序列为 ${JSON.stringify(page.calls.clicksOn)}`,
  );
});

test("浮层已出现但二维码慢一拍时，必须等到二维码可见", async () => {
  const page = createMockPage({
    buttons: [{ name: "role-登录" }],
    probes: [
      { overlayPresent: true, qr: false, hint: true, ok: false },
      { overlayPresent: true, qr: false, hint: true, ok: false },
      { overlayPresent: true, qr: true, hint: true, ok: true },
    ],
  });

  const { openLoginSurface } = buildOpenLoginSurface(async () => ({ state: "unknown" }));
  await openLoginSurface(page);

  assert.equal(page.calls.clicks, 1, "浮层已打开时不应重复点击");
});

test("会话已 healthy 时不得点击任何登录按钮", async () => {
  const page = createMockPage({
    buttons: [{ name: "role-登录" }],
    probes: [{ overlayPresent: true, qr: true, hint: true, ok: true }],
  });

  const { openLoginSurface } = buildOpenLoginSurface(async () => ({ state: "healthy" }));
  await openLoginSurface(page);

  assert.equal(page.calls.clicks, 0, "已登录页面不应被打扰");
});

test("候选按钮点击抛错（被遮挡）时必须继续尝试，不得让异常冒泡", async () => {
  const page = createMockPage({
    buttons: [{ name: "role-登录", clickForcedFails: true, dispatchFails: true }],
    probes: [{ overlayPresent: true, qr: true, hint: true, ok: true }],
  });

  const { openLoginSurface } = buildOpenLoginSurface(async () => ({ state: "unknown" }));
  await assert.doesNotReject(() => openLoginSurface(page));
});

test("★ 必须用 force click：camoufox 下无 force 的 click 会超时，二维码永远不出现", async () => {
  // 真实实测（2026-09-20，camoufox + 虚拟显示）：
  //   locator.click()             → Timeout 5000ms，浮层不出现
  //   locator.click({force:true}) → 浮层 + 二维码出现
  // 本用例断言源码确实走了 force 分支。
  const falseProbe = { overlayPresent: false, qr: false, hint: false, ok: false };
  const okProbe = { overlayPresent: true, qr: true, hint: true, ok: true };
  const page = createMockPage({
    buttons: [{ name: "role-登录" }],
    probes: [falseProbe, okProbe],
  });

  const { openLoginSurface } = buildOpenLoginSurface(async () => ({ state: "unknown" }));
  await openLoginSurface(page);

  assert.equal(page.calls.forced, 1, "必须以 force click 打开浮层");
  assert.equal(page.calls.dispatched, 0, "force click 成功时不应再走 dispatchEvent 兜底");
});

test("force click 失败时必须回退到 dispatchEvent，不得直接放弃", async () => {
  const okProbe = { overlayPresent: true, qr: true, hint: true, ok: true };
  const page = createMockPage({
    buttons: [{ name: "role-登录", clickForcedFails: true }],
    probes: [okProbe],
  });

  const { openLoginSurface } = buildOpenLoginSurface(async () => ({ state: "unknown" }));
  await openLoginSurface(page);

  assert.equal(page.calls.dispatched, 1, "force click 失败后应走 dispatchEvent 兜底");
});

// ---------------------------------------------------------------------------
// 二维码过期自愈（2026-09-20）
//
// 实测证据：会话就绪后立刻截图是清晰的活码（qr-e7e501ca-0ms.png，94739B）；
// 若放着不扫，二维码区域会变成「二维码失效 / 点击刷新」占位图
// （authshot-ae8e2ed3.png，该码已开 3 分钟未刷新）。
// 该占位图容器同样 >=80x80 且可见，因此单看「有二维码容器」会把失效误判为可用。
// ---------------------------------------------------------------------------

const EXPIRED_PROBE = {
  overlayPresent: true,
  qr: true,
  hint: true,
  expired: true,
  ok: false,
};
const LIVE_PROBE = {
  overlayPresent: true,
  qr: true,
  hint: true,
  expired: false,
  ok: true,
};

function buildRefreshHarness(refreshLocators) {
  const calls = { refreshed: 0, forced: 0, dispatched: 0 };
  const makeLocator = (list) => ({
    async count() {
      return list.length;
    },
    nth(index) {
      return list[index];
    },
  });
  const locators = refreshLocators.map((item) =>
    makeLocator([
      {
        async isVisible() {
          return item.visible !== false;
        },
        async click(options = {}) {
          if (options.force) {
            calls.forced += 1;
            if (item.forceFails) throw new Error("covered");
          }
          calls.refreshed += 1;
        },
        async dispatchEvent() {
          calls.dispatched += 1;
          if (item.dispatchFails) throw new Error("dispatch failed");
          calls.refreshed += 1;
        },
      },
    ]),
  );

  let probeIndex = 0;
  const probes = refreshLocators.probes ?? [];
  const page = {
    calls,
    getByText() {
      return locators.shift() ?? makeLocator([]);
    },
    getByRole() {
      return locators.shift() ?? makeLocator([]);
    },
    async waitForTimeout() {},
    async evaluate() {
      const probe = probes[Math.min(probeIndex, probes.length - 1)];
      probeIndex += 1;
      return probe;
    },
  };
  return page;
}

function buildRefreshQr() {
  const context = { console };
  vm.createContext(context);
  vm.runInContext(
    `${loginSurfaceVisibleSource}\n${extractFunction("refreshQrIfExpired")}`,
    context,
  );
  return context;
}

test("二维码过期时必须点击刷新，而不是把失效占位图当可用码", async () => {
  const ctx = buildRefreshQr();
  const locators = [
    { visible: true }, // getByText("点击刷新")
    { visible: true }, // getByText("刷新")
    { visible: true }, // getByRole button 刷新
  ];
  locators.probes = [EXPIRED_PROBE];
  const page = buildRefreshHarness(locators);

  const refreshed = await ctx.refreshQrIfExpired(page);
  assert.equal(refreshed, true, "过期时必须执行刷新");
  assert.equal(page.calls.forced, 1, "刷新也必须用 force click（camoufox 下必需）");
});

test("二维码有效时绝不点击刷新（避免打断用户正在扫的码）", async () => {
  const ctx = buildRefreshQr();
  const locators = [{ visible: true }, { visible: true }];
  locators.probes = [LIVE_PROBE];
  const page = buildRefreshHarness(locators);

  const refreshed = await ctx.refreshQrIfExpired(page);
  assert.equal(refreshed, false, "码有效时不应刷新");
  assert.equal(page.calls.refreshed, 0);
});

test("浮层不存在时刷新探测是安全空操作", async () => {
  const ctx = buildRefreshQr();
  const locators = [{ visible: true }];
  locators.probes = [{ overlayPresent: false, qr: false, hint: false, expired: false, ok: false }];
  const page = buildRefreshHarness(locators);

  const refreshed = await ctx.refreshQrIfExpired(page);
  assert.equal(refreshed, false);
  assert.equal(page.calls.refreshed, 0);
});

test("刷新点击失败不得抛错冒泡（否则会打断整个登录会话）", async () => {
  const ctx = buildRefreshQr();
  const locators = [
    { visible: true, forceFails: true, dispatchFails: true },
    { visible: true, forceFails: true, dispatchFails: true },
    { visible: true, forceFails: true, dispatchFails: true },
  ];
  locators.probes = [EXPIRED_PROBE];
  const page = buildRefreshHarness(locators);

  await assert.doesNotReject(() => ctx.refreshQrIfExpired(page));
});

test("过期判定必须进 ok 判据，且 capture 在截图前先自愈", () => {
  // 静态契约：锁死两件事不被后续重构抹掉。
  const remoteAuth = readFileSync(
    path.join(here, "..", "src", "api", "remote-auth.js"),
    "utf8",
  );

  assert.match(
    remoteAuth,
    /expired/,
    "loginSurfaceVisible 必须返回 expired 信号",
  );
  assert.match(
    remoteAuth,
    /ok:\s*overlayPresent\s*&&\s*qr\s*&&\s*!expired/,
    "★ 失效二维码不得被判为 ok —— 否则过期会被当成可用",
  );

  // capture() 里必须在 screenshot 之前调用刷新。
  const captureStart = remoteAuth.indexOf("async function capture(runtime)");
  assert.ok(captureStart > 0, "源码中应存在 capture()");
  const captureBody = remoteAuth.slice(captureStart, remoteAuth.indexOf("\n}\n", captureStart));
  const refreshAt = captureBody.indexOf("refreshQrIfExpired(page)");
  const shotAt = captureBody.indexOf("page.screenshot(");
  assert.ok(refreshAt > 0, "capture() 必须调用 refreshQrIfExpired");
  assert.ok(shotAt > 0, "capture() 必须截图");
  assert.ok(
    refreshAt < shotAt,
    `★ 刷新必须发生在截图之前（实际 refresh@${refreshAt} vs shot@${shotAt}），否则截到的仍是失效占位图`,
  );
});
