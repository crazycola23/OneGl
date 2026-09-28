import assert from "node:assert/strict";
import test from "node:test";

import {
  isHashBearingClass,
  isUtilityClass,
  isVolatileDataValue,
  suggestSelector,
  suggestSelectors,
  rankAnswerCandidates,
  externalLinkHosts,
  captureOpenQuestions,
  collectPageSignals,
} from "../src/providers/phase0.js";
import {
  assertProviderProfile,
  collectProfileErrors,
  collectProfileWarnings,
  deriveSessionCookieCandidates,
} from "../src/providers/profile.js";
import {
  doubaoWebProvider,
} from "../src/providers/doubao-web.js";
import {
  getProviderAdapter,
  listProviderAdapters,
  pendingProviderProfiles,
  providerProfileGaps,
  selectRegistrableAdapters,
  supportedProviderIds,
} from "../src/providers/index.js";
import { yuanbaoWebProfile } from "../src/providers/yuanbao-web.js";
import { zhipuWebProfile, zhipuWebProvider } from "../src/providers/zhipu-web.js";
import { qianwenWebProfile, qianwenWebProvider } from "../src/providers/qianwen-web.js";

test("build-hash class names are never turned into selectors", () => {
  // 豆包远端登录踩过这个：qrcode-DeN5Ny 换个构建就选不中了。
  assert.equal(isHashBearingClass("qrcode-DeN5Ny"), true);
  assert.equal(isHashBearingClass("css-1a2b3c"), true);
  assert.equal(isHashBearingClass("md-box-root"), false);
  assert.equal(suggestSelector({ classTokens: ["qrcode-DeN5Ny"] }), '[class*="qrcode"]');
  assert.equal(suggestSelector({ classTokens: ["md-box-root", "foo"] }), ".md-box-root");
});

test("Tailwind utilities are rejected as selectors", () => {
  // 第一次真实抓取千问时，探针交出的正是这两个"候选"：
  //   composer -> .min-h-[24px]      send -> .inline-flex
  // 它们描述的是布局，不是身份。
  assert.equal(isUtilityClass("inline-flex"), true);
  assert.equal(isUtilityClass("flex-col"), true);
  assert.equal(isUtilityClass("min-h-[24px]"), true);
  assert.equal(isUtilityClass("text-16"), true);
  assert.equal(isUtilityClass("rounded-10"), true);
  assert.equal(isUtilityClass("placeholder:text-disabled"), true);
  assert.equal(isUtilityClass("md-box-root"), false);
  assert.equal(suggestSelector({ classTokens: ["relative", "min-h-[24px]", "w-full"] }), null);
  assert.equal(suggestSelector({ classTokens: ["inline-flex"] }), null);
});

test("semantic data attributes outrank copy, and runtime ids are rejected", () => {
  // 千问输入框同时带 data-slate-editor="true" 和 data-placeholder="向千问提问"。
  // 文案是会被产品改的那个，所以不能选它。
  assert.equal(
    suggestSelector({
      data: { "data-slate-editor": "true", "data-placeholder": "向千问提问" },
      classTokens: ["min-h-[24px]"],
    }),
    '[data-slate-editor="true"]',
  );
  // Radix/emotion 运行时 id（:ro:）每次构建都可能不同。
  assert.equal(suggestSelector({ testid: ":ro:", data: { "data-testid": ":ro:" } }), null);
  assert.equal(
    suggestSelector({ data: { "data-testid": ":ro:" } }),
    null,
  );
  assert.equal(
    suggestSelector({ data: { "data-testid": "qianwen-layout-left-panel" } }),
    '[data-testid="qianwen-layout-left-panel"]',
  );
  assert.equal(isVolatileDataValue("ab"), true);
  assert.equal(isVolatileDataValue(":ro:"), true);
  assert.equal(isVolatileDataValue("chat_input_input"), false);
});

test("structural attributes outrank classes and classes outrank nothing", () => {
  assert.equal(
    suggestSelector({ testid: "chat_input_input", classTokens: ["md-box-root"] }),
    '[data-testid="chat_input_input"]',
  );
  assert.equal(
    suggestSelector({ role: "button", aria: "发送", classTokens: ["btn"] }),
    '[role="button"][aria-label="发送"]',
  );
  assert.equal(suggestSelector({ placeholder: "有问题尽管问我" }), '[placeholder*="有问题尽管问我"]');
  assert.equal(suggestSelector({ classTokens: [] }), null);
  assert.deepEqual(
    suggestSelectors([
      { testid: "chat_input_send_button" },
      { testid: "chat_input_send_button" },
      { testid: "chat_input_input" },
    ]),
    ['[data-testid="chat_input_send_button"]', '[data-testid="chat_input_input"]'],
  );
});

test("the user's own prompt is never proposed as the answer container", () => {
  const prompt = "2026 年新能源汽车推荐";
  const ranked = rankAnswerCandidates(
    [
      { length: 900, text: `${prompt}，我帮你查一下`, classTokens: ["user-bubble"] },
      { length: 2400, text: "根据公开资料，推荐以下品牌……", classTokens: ["answer-md"] },
      { length: 12, text: "短到不可能是答案" },
    ],
    prompt,
  );
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].classTokens[0], "answer-md");
});

test("citation host ranking ignores the platform's own domain", () => {
  const hosts = externalLinkHosts(
    [
      { host: "yuanbao.tencent.com" },
      { host: "autobao.com.cn" },
      { host: "autobao.com.cn" },
      { host: "news.example.cn" },
    ],
    ["yuanbao.tencent.com"],
  );
  assert.deepEqual(hosts, [
    { host: "autobao.com.cn", count: 2 },
    { host: "news.example.cn", count: 1 },
  ]);
});

test("an anonymous CSRF cookie cannot become a session credential", () => {
  // The exact Doubao mistake: passport_csrf_token exists before any login.
  const diff = deriveSessionCookieCandidates(
    { passport_csrf_token: "d733ee7e", flow_cur_user_sec_id: "" },
    { passport_csrf_token: "d733ee7e", flow_cur_user_sec_id: "8812", sessionid: "abc" },
  );
  assert.deepEqual(
    diff.candidates.map((entry) => entry.name),
    ["flow_cur_user_sec_id", "sessionid"],
  );
  assert.deepEqual(diff.unchanged, ["passport_csrf_token"]);
});

test("an unmeasured profile reports its gaps instead of crashing on import", () => {
  assert.equal(yuanbaoWebProfile.validated, false);
  const gaps = collectProfileErrors(yuanbaoWebProfile);
  assert.ok(gaps.some((entry) => entry.includes("login.sessionCookies")));
  assert.ok(gaps.some((entry) => entry.includes("chat.answerSelectors")));
  assert.throws(() => assertProviderProfile(yuanbaoWebProfile), /is incomplete/);
  assert.deepEqual(providerProfileGaps("yuanbao-web"), gaps);
});

test("only measured profiles reach the adapter table, and the contract follows it", () => {
  // 元宝还没做过任何观测，所以它既不在表里也不在枚举里。
  // 智谱清言的 Phase 0 已跑通并注册（docs/ZHIPU_PHASE0.md）。
  assert.deepEqual(listProviderAdapters().map((entry) => entry.id), [
    "doubao-web",
    "qianwen-web",
    "zhipu-web",
  ]);
  assert.throws(() => getProviderAdapter("yuanbao"), /Unsupported provider adapter/);
  assert.deepEqual(pendingProviderProfiles.map((entry) => entry.id), ["yuanbao-web"]);
  // 公开枚举由 adapter 表推导，客户端不可能拿到采集端跑不了的平台。
  assert.deepEqual(supportedProviderIds(), ["doubao", "qianwen", "zhipu"]);
});

test("the registration gate is the profile's validated flag and nothing else", () => {
  assert.deepEqual(
    selectRegistrableAdapters([doubaoWebProvider, qianwenWebProvider, zhipuWebProvider]).map((a) => a.id),
    ["doubao-web", "qianwen-web", "zhipu-web"],
  );

  const withdrawn = {
    ...qianwenWebProvider,
    profile: { ...qianwenWebProfile, validated: false },
  };
  assert.deepEqual(
    selectRegistrableAdapters([doubaoWebProvider, withdrawn]).map((a) => a.id),
    ["doubao-web"],
    "flipping one flag is the whole rollback",
  );
});

test("yuanbao stays unregistered while nothing about it has been measured", () => {
  assert.equal(yuanbaoWebProfile.validated, false);
  assert.throws(() => getProviderAdapter("yuanbao"), /Unsupported provider adapter/);
});

/**
 * 智谱清言：Phase 0 跑通后**已注册**，因为 src/zhipu.js 正面解决了当初拦住它的那个问题。
 *
 * 当初不注册的理由是「答案容器没有稳定标识、同页页脚比答案更长」，按最长文本块取答案
 * 会稳定取到页脚。driver 现在按「问题气泡之后的对话容器」取全文并显式排除
 * .policy-wrap，所以那条限制由 driver 承担而不是被绕过。
 *
 * 这组断言盯的是它**没有**被顺手带进去的东西：撞额度墙的文案仍未实测，
 * citation 的来源是裸域名角标而非可点击链接。
 */
test("zhipu is registered, and its pacing reflects the measured wall", () => {
  assert.equal(zhipuWebProfile.validated, true);
  assert.equal(getProviderAdapter("zhipu").id, "zhipu-web");
  assert.equal(getProviderAdapter("zhipu").requiresStoredAuth, false);
  // 匿名面：不需要登录态，也不参与账号额度。
  assert.equal(getProviderAdapter("zhipu").frontEndGuard, undefined);
  assert.equal(pendingProviderProfiles.some((p) => p.id === "zhipu-web"), false);

  // 撞墙文案已按 2026-09-28 实测登记（访问验证页）。这条断言盯的是「登记了」本身：
  // 认不出撞墙就只能记成 TIMEOUT 或页面结构错乱，报告和告警读不出真相，
  // 而处置方式完全不同 —— 要等平台放行，不是换选择器。
  assert.ok(
    zhipuWebProfile.quota.exhaustedPatterns.length > 0,
    "撞墙文案必须登记，否则风控会被误报成超时或页面结构错乱",
  );
  assert.ok(
    zhipuWebProfile.quota.exhaustedPatterns.some((p) => p.test("访问验证 别离开")),
    "必须能识别实测到的访问验证页文案",
  );

  // 节奏：2026-09-28 实测 15-33 秒间隔可连跑 9 次成功，紧接着的 4 题批次立刻撞墙。
  // 分界线是连续提问的累积量而非单题频率，所以间隔要明显高于其它平台（30-90 秒），
  // 量级要保守 —— 撞墙后恢复要等 20-30 分钟，硬顶只会把剩下的问题烧掉。
  assert.ok(
    zhipuWebProfile.limits.minDelayMs >= 60_000,
    "匿名面撞墙的代价是白烧，间隔不应低于 60 秒",
  );
  assert.deepEqual(collectProfileErrors(zhipuWebProfile), []);
});

/**
 * 智谱清言 profile 的实测取值（`docs/ZHIPU_PHASE0.md`）。
 *
 * 这些值全部来自 2026-09-27 在本地 Camoufox 出货引擎上的实测，不是从豆包或
 * 千问类比来的 —— 那是 `docs/MULTI_PLATFORM_LESSONS.md` §1/§2 记着的两次翻车原因。
 * 这里逐条钉住，因为它们各自对应一个「填错了不会报错、只会静默采错」的地方。
 */
test("zhipu profile carries the measured selectors, not plausible-looking ones", () => {
  // 输入框：唯一可编辑元素，没有 placeholder / aria-label / data-testid，
  // 唯一类名是工具类 scroll-display-none，另有每次构建都变的 Vue scoped 哈希。
  assert.deepEqual(zhipuWebProfile.chat.composerSelectors, ["textarea"]);
  // 问题气泡实测有稳定类名，答案侧没有 —— 所以答案定位必须靠这个结构关系。
  assert.deepEqual(zhipuWebProfile.chat.userBubbleSelectors, ['[class*="question-txt"]']);
  assert.equal(zhipuWebProfile.quota.promptsPerWindow, 1);

  // 发送控件是纯 SVG（无 class / 无 aria-label / 无文字），实测 Enter 可提交。
  // sendSelectors 在 profile.js 里是**必填**（不像 exhaustedPatterns 那样算诊断级），
  // 所以这里不能留空。指向输入框是准确的：焦点在输入框时按 Enter 就是实测通过的
  // 提交路径，driver 不应把它当成「点这个按钮」。
  assert.deepEqual(zhipuWebProfile.chat.sendSelectors, ["textarea"]);

  // 答案选择器必须先按问题气泡定位：同页页脚 policy-wrap 实测 101 字符，
  // 比 54 字符的答案还长，「取最长」会稳定取到页脚。
  assert.ok(
    zhipuWebProfile.chat.answerSelectors[0].includes("question-txt"),
    "答案选择器必须先按问题气泡定位，否则页脚会被当成答案",
  );

  // 空数组是「还没量到」的诚实表达：撞墙文案未观测（走 warning），
  // 会话 URL 始终停在 /main/alltoolsdetail，没有会话 id 进入路径。
  assert.deepEqual(zhipuWebProfile.login.loginSurfaceSelectors, []);
  assert.equal(zhipuWebProfile.chat.conversationUrlPattern, null);

  // 匿名面：六个 cookie（chatglm_token 等）实测值全为空，不构成会话凭据。
  // 把它们写进 sessionCookies 就会重演豆包「CSRF cookie 当凭证」那次事故。
  assert.equal(zhipuWebProfile.requiresStoredAuth, false);
  assert.deepEqual(zhipuWebProfile.login.sessionCookies, []);

  // 引用口径：平台自陈「N个来源」，来源是裸域名角标而非 <a> 标签。
  assert.equal(zhipuWebProfile.citation.tier, "self-reported-count");
  assert.equal(zhipuWebProfile.citation.countPattern.source, "(\\d+)\\s*个来源");
});

test("the zhipu adapter is wired to the real driver, not a stub", async () => {
  // 早先这里断言 openPage/run 会拒绝执行，因为那时只有骨架。Phase 0 跑通后
  // src/zhipu.js 落地，adapter 已接到真实 driver —— 桩被删掉了，这条断言也随之失效。
  // 现在钉住「接的是真 driver」：接口齐备，且 openPage 会在没有 page 时立刻失败，
  // 而不是静默返回 undefined 让上层以为页面已就绪。
  assert.equal(typeof zhipuWebProvider.openPage, "function");
  assert.equal(typeof zhipuWebProvider.run, "function");
  assert.equal(zhipuWebProvider.profile, zhipuWebProfile);
  // 没有 page 就必须立刻失败：返回一个假的 page 会让采集器以为已经打开页面，
  // 后续每一步都在 undefined 上操作，报错点被推迟到很难定位的地方。
  // openZhipu 是 async（page.goto 走 await），所以必须用 rejects ——
  // assert.throws 只同步捕获，对 rejected promise 无效。
  await assert.rejects(() => zhipuWebProvider.openPage(undefined, {}, zhipuWebProfile), TypeError);
});

test("an anonymous surface is judged on quota, not on a login it will never have", () => {
  const gaps = collectProfileErrors(qianwenWebProfile);
  const warnings = collectProfileWarnings(qianwenWebProfile);
  assert.equal(qianwenWebProfile.requiresStoredAuth, false);
  // No session to measure, so no cookie list may be demanded of it.
  assert.equal(gaps.some((entry) => entry.includes("login.sessionCookies")), false);
  // Everything the driver reads has been observed, so nothing integrity-critical is missing.
  assert.deepEqual(gaps, []);
  // The cap copy stays unobserved, and that is now the honest state rather than an oversight:
  // the wall's own text is inside a cross-origin iframe, so no body-text scan can read it.
  assert.deepEqual(warnings, [
    "qianwen-web.quota.exhaustedPatterns must be a non-empty array of strings",
  ]);

  // The wall is detected by the login surface instead. Measured 2026-09-23: this iframe is
  // injected only when the wall appears (1 occurrence on the walled run, 0 on the healthy runs
  // either side of it), so its presence is the signal that survives a copy it cannot read.
  assert.deepEqual(qianwenWebProfile.login.loginSurfaceSelectors, ['iframe[src*="passport.qianwen.com"]']);
  assert.deepEqual(qianwenWebProfile.quota.exhaustedPatterns, []);

  const questions = captureOpenQuestions({ requiresStoredAuth: false, answerCandidates: [{ selector: ".x" }] });
  assert.ok(questions.some((entry) => /额度/.test(entry)));
  // A missing login is not an open question when there is no login in this design.
  assert.equal(questions.some((entry) => /session cookie 名单/.test(entry)), false);
});

test("open questions name the decisions a capture could not settle", () => {
  const questions = captureOpenQuestions({
    hasLoggedIn: false,
    qrSurfaceObserved: false,
    expiredQrObserved: null,
    answerCandidates: [],
    conversationUrlObserved: false,
  });
  assert.equal(questions.length, 6);
  assert.ok(questions.some((entry) => /安全边界/.test(entry)));
  assert.ok(questions.some((entry) => /dom-only/.test(entry)));
  assert.deepEqual(captureOpenQuestions({
    hasLoggedIn: true,
    qrSurfaceObserved: true,
    expiredQrObserved: true,
    answerCandidates: [{ selector: ".x" }],
    selfReportedCitationCount: 5,
    conversationUrlObserved: true,
  }), []);
});

test("the page collector is self-contained", () => {
  // It runs inside page.evaluate, so any closure over this module would throw in the browser.
  assert.equal(typeof collectPageSignals, "function");
  // Default parameters are excluded from .length, so check the source for the parameter.
  assert.match(collectPageSignals.toString(), /^function \w+\(\s*markers/);
  assert.doesNotMatch(collectPageSignals.toString(), /\b(suggestSelector|isHashBearingClass|HASH_TOKEN)\b/);
});
