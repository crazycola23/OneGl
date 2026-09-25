import assert from "node:assert/strict";
import test from "node:test";

import { camoufoxLaunchPayload } from "../src/browser.js";
import { loadConfig } from "../src/config.js";
import {
  identityPromptsAfterRelaunch,
  promptCountForBatch,
  safetyConfig,
  shouldRotateContext,
  shouldRotateIdentity,
  windowPromptLimit,
} from "../src/accounts/safety.js";
import { qianwenWebProfile } from "../src/providers/qianwen-web.js";

function browserConfig(overrides = {}) {
  return loadConfig({
    dataDir: "/tmp/onegl-window-test",
    browser: "camoufox",
    camoufoxMode: "virtual",
    ...overrides,
  });
}

test("Camoufox launch payload agrees with the Playwright context it feeds", () => {
  const config = browserConfig({ locale: "zh-CN", viewportWidth: 1440, viewportHeight: 900 });
  const payload = camoufoxLaunchPayload(config, { mode: "virtual" });

  // Camoufox randomised the OS (and with it UA, font metrics and WebGL vendor) on every
  // launch while the context pinned locale/timezone/viewport, so the two layers described
  // different machines.
  assert.equal(payload.os, config.camoufoxOs);
  assert.equal(payload.locale, config.locale);
  assert.deepEqual(payload.window, [1440, 900]);
  assert.deepEqual(payload.screen_size, { width: 1440, height: 900 });
  assert.equal(
    payload.screen_size.width >= config.viewportWidth,
    true,
    "reported screen must never be smaller than the pinned viewport",
  );
});

test("screen is pinned explicitly instead of inherited from the 1x1 Xvfb display", () => {
  const payload = camoufoxLaunchPayload(browserConfig(), {
    mode: "virtual",
    virtualDisplay: ":42",
  });
  assert.equal(payload.virtual_display, ":42");
  assert.equal(payload.headless, false, "virtual mode runs a real window on Xvfb");
  assert.deepEqual(
    [payload.screen_size.width, payload.screen_size.height],
    [payload.window[0], payload.window[1]],
  );
});

test("headless mode is the only mode that reports headless to Camoufox", () => {
  assert.equal(camoufoxLaunchPayload(browserConfig(), { mode: "headless" }).headless, true);
  assert.equal(camoufoxLaunchPayload(browserConfig(), { mode: "headful" }).headless, false);
});

test("an unpinned viewport is rejected before it reaches the Python launcher", () => {
  assert.throws(
    () => camoufoxLaunchPayload({ camoufoxOs: "windows", viewportWidth: 0, viewportHeight: 900 }),
    /positive integer size/,
  );
});

test("ONEGL_CAMOUFOX_OS is validated and defaults to windows", () => {
  assert.equal(browserConfig().camoufoxOs, "windows");
  assert.equal(browserConfig({ camoufoxOs: " LINUX " }).camoufoxOs, "linux");
  assert.throws(() => browserConfig({ camoufoxOs: "solaris" }), /must be windows, macos, or linux/);
});

test("window rotation fires on the configured prompt count only", () => {
  assert.equal(shouldRotateContext(0, 3), false);
  assert.equal(shouldRotateContext(2, 3), false);
  assert.equal(shouldRotateContext(3, 3), true, "the limit is inclusive of the served prompts");
  assert.equal(shouldRotateContext(1, 0), false, "0 disables rotation entirely");
  assert.equal(shouldRotateContext(99, null), false);
  // 默认必须是关的：开着它等于顺手改掉豆包的会话行为，那是另一件事。
  assert.equal(safetyConfig().roundPromptLimit, Number(process.env.ONEGL_ROUND_PROMPT_LIMIT ?? 0));
  assert.equal(windowPromptLimit(undefined, 0), 0, "a provider with no profile value inherits the global default");
});

test("a provider declares its own isolation strength without moving anyone else", () => {
  // 千问每问一个干净会话；豆包没有 profile，仍按全局默认。
  assert.equal(windowPromptLimit(1, 0), 1);
  assert.equal(windowPromptLimit(qianwenWebProfile.quota.promptsPerWindow, 0), 1);
  assert.equal(windowPromptLimit(undefined, 3), 3);
  assert.equal(windowPromptLimit(0, 3), 3, "0 from a profile means unset, not rotate-every-prompt");
});

test("device identity rotates every N prompts, and never at all by default", () => {
  const previous = process.env.ONEGL_WINDOW_RESET_EVERY;
  try {
    delete process.env.ONEGL_WINDOW_RESET_EVERY;
    // 默认必须是关的：开着它每次都重启一次 Camoufox 冷启动。
    assert.equal(safetyConfig().windowResetEvery, 0);
    assert.equal(shouldRotateIdentity(99, safetyConfig().windowResetEvery), false);

    process.env.ONEGL_WINDOW_RESET_EVERY = "2";
    assert.equal(safetyConfig().windowResetEvery, 2);

    // 计数是「本浏览器进程服务过几次提问」，归零发生在重启之后，所以第 2 次提问前重启一次，
    // 而不是每问都重启 —— 后者会把 2 的语义读成 1。
    assert.equal(shouldRotateIdentity(0, 2), false);
    assert.equal(shouldRotateIdentity(1, 2), false);
    assert.equal(shouldRotateIdentity(2, 2), true, "the Nth prompt is the one that gets the new fingerprint");
    assert.equal(shouldRotateIdentity(3, 2), true, "a counter that was never reset keeps asking for a relaunch");

    assert.equal(shouldRotateIdentity(1, 0), false, "0 disables identity rotation entirely");
    assert.equal(shouldRotateIdentity(9, null), false);
  } finally {
    if (previous == null) delete process.env.ONEGL_WINDOW_RESET_EVERY;
    else process.env.ONEGL_WINDOW_RESET_EVERY = previous;
  }
});

test("the relaunch policy can be aimed at one provider without touching the others", () => {
  const previousEvery = process.env.ONEGL_WINDOW_RESET_EVERY;
  const previousProviders = process.env.ONEGL_WINDOW_RESET_PROVIDERS;
  try {
    process.env.ONEGL_WINDOW_RESET_EVERY = "2";
    delete process.env.ONEGL_WINDOW_RESET_PROVIDERS;
    const unscoped = safetyConfig();
    assert.deepEqual(unscoped.windowResetProviders, [], "no scope list means no filtering");

    process.env.ONEGL_WINDOW_RESET_PROVIDERS = " qianwen , DOUBAO ";
    const scoped = safetyConfig();
    assert.deepEqual(scoped.windowResetProviders, ["qianwen", "doubao"]);

    const scope = { providers: scoped.windowResetProviders };
    assert.equal(
      shouldRotateIdentity(2, scoped.windowResetEvery, { provider: "qianwen", ...scope }),
      true,
    );
    assert.equal(
      shouldRotateIdentity(2, scoped.windowResetEvery, { provider: "doubao", ...scope }),
      true,
      "the list is a filter, not a single-provider allowlist",
    );
    // 名单外的平台必须完全不受影响：它的浏览器进程照旧长期复用。
    assert.equal(
      shouldRotateIdentity(2, scoped.windowResetEvery, { provider: "yuanbao", ...scope }),
      false,
    );
    assert.equal(
      shouldRotateIdentity(2, scoped.windowResetEvery, { provider: null, ...scope }),
      false,
      "an unknown provider must not inherit a scoped relaunch policy",
    );
  } finally {
    if (previousEvery == null) delete process.env.ONEGL_WINDOW_RESET_EVERY;
    else process.env.ONEGL_WINDOW_RESET_EVERY = previousEvery;
    if (previousProviders == null) delete process.env.ONEGL_WINDOW_RESET_PROVIDERS;
    else process.env.ONEGL_WINDOW_RESET_PROVIDERS = previousProviders;
  }
});

test("the two rotation counters are independent decisions", () => {
  // 千问 = 每问换窗口；重启浏览器是另一回事，不能被窗口限制顺带触发。
  const limit = windowPromptLimit(qianwenWebProfile.quota.promptsPerWindow, 0);
  assert.equal(shouldRotateContext(1, limit), true);
  assert.equal(
    shouldRotateIdentity(1, 2, { provider: "qianwen", providers: ["qianwen"] }),
    false,
    "a window rotation must not imply a relaunch",
  );
});

test("identity rotation survives a restart because the position comes from the batch count", () => {
  // 线上真实形态：千问 promptsPerWindow=1，于是每一轮都走 rotateContext()，而那个动作会把
  // contextPrompts 归零。所以身份轮换既不能读 contextPrompts（每轮被抹平，永远不触发），
  // 也不能只读内存计数（每次 worker 重启都从 0 重数，同一个身份会连任，实际周期变成 N+1）。
  // 判据取自批次内已服务的提问数，于是「第几条用哪个身份」在任何重启点都算得出来。
  const every = 2;
  const batches = [
    { uptime: 1, served: 0 },
    { uptime: 2, served: 1 },
    { uptime: 3, served: 2 }, // 重启发生在第 3 条之前
    { uptime: 4, served: 3 },
    { uptime: 5, served: 4 },
    { uptime: 6, served: 5 },
  ];

  const rotations = batches.filter(
    (step) => step.served > 0 && identityPromptsAfterRelaunch(step.served, every) === 0,
  );
  assert.deepEqual(
    rotations.map((step) => step.served),
    [2, 4],
    "位置 2 和 4 开新身份；位置 3、5 继续用当前身份",
  );

  // 把整条批次铺开看：每个身份组恰好服务 every 条，且相邻两组身份不同。
  const groupOf = (served) => Math.floor(served / every);
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map(groupOf),
    [0, 0, 1, 1, 2, 2],
    "第 1、2 条同一身份；第 3、4 条换一个；第 5、6 条再换一个",
  );

  // 重启接上后不会重复已经用过的身份：从任意位置继续，组号只能前进，不能回退。
  let previousGroup = groupOf(2);
  for (let served = 2; served <= 9; served += 1) {
    const current = groupOf(served);
    assert.ok(current >= previousGroup, `位置 ${served} 的组号不能回退`);
    previousGroup = current;
  }
});

test("the relaunch boundary keeps exactly N prompts per identity", () => {
  // 余数为 0 就是组边界。0 本身除外：批次起步时还没有身份可换。
  assert.equal(identityPromptsAfterRelaunch(0, 2), 0, "位置 0 是起点，不该触发轮换");
  assert.equal(identityPromptsAfterRelaunch(2, 2), 0);
  assert.equal(identityPromptsAfterRelaunch(4, 2), 0);
  assert.equal(identityPromptsAfterRelaunch(3, 2), 1, "组内位置要保留，不能一律清零");
  assert.equal(identityPromptsAfterRelaunch(2, 1), 0, "每 1 条换一次时每一步都是边界");
  assert.equal(identityPromptsAfterRelaunch(0, 3), 0);

  // 闭环：每个身份在 N=3 下恰好服务 3 条，第 3 条之后才换。
  const every = 3;
  const serves = [];
  let current = null;
  for (let served = 0; served < 9; served += 1) {
    if (served > 0 && identityPromptsAfterRelaunch(served, every) === 0) {
      serves.push(current);
      current = 0;
    }
    current = (current ?? 0) + 1;
  }
  assert.deepEqual(serves, [every, every], "9 条、每 3 条一换，前两个身份各服务 3 条");
  assert.equal(current, 3, "剩下的第三个身份也服务 3 条");
});

test("the batch position query degrades instead of throwing", async () => {
  // 这个计数在一个热路径上（每次提问前），拿不到数据库时必须是「当作第 0 条」而不是抛错 ——
  // 抛错会让整批任务连锁失败，那比轮换算不准严重得多。
  assert.equal(
    await promptCountForBatch(null, { batchId: 66, accountKey: "a", provider: "qianwen" }),
    0,
  );
  assert.equal(
    await promptCountForBatch(
      { query: async () => ({ rows: [] }) },
      { batchId: undefined, accountKey: "a", provider: "qianwen" },
    ),
    0,
  );

  // 正常返回路径，顺带确认查询用的是 (批次, 账号, 平台) 三元组。
  let seen = null;
  const pool = {
    query: async (sql, params) => {
      seen = { sql, params };
      return { rows: [{ served: 29 }] };
    },
  };
  assert.equal(
    await promptCountForBatch(pool, { batchId: 66, accountKey: "t1_x", provider: "qianwen" }),
    29,
  );
  assert.deepEqual(seen.params, [66, "t1_x", "qianwen"]);
  assert.match(seen.sql, /sampling_batch_id/);
});

test("slot counting only splits the query once concurrency is actually on", async () => {
  // 单槽位（默认）时必须退化成改造前那条不带槽位条件的查询：存量行的 request_slot 都是 0，
  // 但「没开并发就等于改造前的行为」这条意图不该依赖那个默认值来成立。
  const previous = process.env.ONEGL_ACCOUNT_SLOTS;
  try {
    delete process.env.ONEGL_ACCOUNT_SLOTS;
    assert.equal(safetyConfig().accountSlots, 1, "默认必须是 1，否则存量部署的行为会被改动");

    let single = null;
    await promptCountForBatch(
      { query: async (sql, params) => ((single = { sql, params }), { rows: [{ served: 1 }] }) },
      { batchId: 66, accountKey: "a", provider: "qianwen" },
    );
    assert.equal(single.params.length, 3, "单槽位不带 request_slot 参数");
    assert.ok(!/request_slot/.test(single.sql), "单槽位不该出现槽位条件");

    // 开并发后才按槽位切分，且槽位号进 WHERE。
    process.env.ONEGL_ACCOUNT_SLOTS = "3";
    assert.equal(safetyConfig().accountSlots, 3);

    const seen = [];
    const pool = {
      query: async (sql, params) => {
        seen.push({ sql, params });
        return { rows: [{ served: 4 }] };
      },
    };
    for (const slot of [0, 1, 2]) {
      assert.equal(
        await promptCountForBatch(pool, { batchId: 66, accountKey: "a", provider: "qianwen", slot }),
        4,
      );
    }
    assert.equal(seen.length, 3, "三个槽位各查一次");
    assert.deepEqual(seen.map((entry) => entry.params[3]), [0, 1, 2], "槽位号进查询参数");
    for (const entry of seen) {
      assert.match(entry.sql, /request_slot = \$4/, "多槽位时按 request_slot 切分");
    }

    // 越界或非整数的槽位号必须回落到 0，而不是拼出一个查不到任何行的条件。
    await promptCountForBatch(pool, { batchId: 66, accountKey: "a", provider: "qianwen", slot: 99 });
    assert.equal(seen.at(-1).params[3], 0, "越界槽位回落到 0");
    await promptCountForBatch(pool, { batchId: 66, accountKey: "a", provider: "qianwen", slot: null });
    assert.equal(seen.at(-1).params[3], 0, "非整数槽位回落到 0");
  } finally {
    if (previous == null) delete process.env.ONEGL_ACCOUNT_SLOTS;
    else process.env.ONEGL_ACCOUNT_SLOTS = previous;
  }
});
