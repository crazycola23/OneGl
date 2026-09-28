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
import { wenxinWebProfile, wenxinWebProvider } from "../src/providers/wenxin-web.js";

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
  // 智谱清言与文心一言的 Phase 0 已跑通并注册（docs/ZHIPU_PHASE0.md、docs/WENXIN_PHASE0.md）。
  assert.deepEqual(listProviderAdapters().map((entry) => entry.id), [
    "doubao-web",
    "qianwen-web",
    "zhipu-web",
    "wenxin-web",
  ]);
  assert.throws(() => getProviderAdapter("yuanbao"), /Unsupported provider adapter/);
  assert.deepEqual(pendingProviderProfiles.map((entry) => entry.id), ["yuanbao-web"]);
  // 公开枚举由 adapter 表推导，客户端不可能拿到采集端跑不了的平台。
  assert.deepEqual(supportedProviderIds(), ["doubao", "qianwen", "wenxin", "zhipu"]);
});

test("the registration gate is the profile's validated flag and nothing else", () => {
  assert.deepEqual(
    selectRegistrableAdapters([
      doubaoWebProvider,
      qianwenWebProvider,
      zhipuWebProvider,
      wenxinWebProvider,
    ]).map((a) => a.id),
    ["doubao-web", "qianwen-web", "zhipu-web", "wenxin-web"],
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

/**
 * 文心一言：Phase 0 跑通后已注册（`docs/WENXIN_PHASE0.md`，2026-09-28 十四轮探针）。
 *
 * 智谱那一组盯的是「撞墙文案仍未实测」；文心这一组盯的是**已实测的墙形态**——
 * 它的墙不是原地替换而是整页导航，所以判据必须落在 URL 与正文上。
 */
test("wenxin is registered, and its wall is recognised as a navigation, not a missing composer", () => {
  assert.equal(wenxinWebProfile.validated, true);
  assert.equal(getProviderAdapter("wenxin").id, "wenxin-web");
  assert.equal(getProviderAdapter("wenxin").requiresStoredAuth, false);
  assert.equal(getProviderAdapter("wenxin").frontEndGuard, undefined);
  assert.equal(pendingProviderProfiles.some((p) => p.id === "wenxin-web"), false);

  // 撞墙文案逐字实测（wappass.baidu.com 的滑块验证页）。这条断言盯的是「登记了」本身：
  // 认不出撞墙就只能记成 TIMEOUT 或 ANSWER_NOT_FOUND，而处置方式完全不同 —— 要等平台放行。
  assert.ok(
    wenxinWebProfile.quota.exhaustedPatterns.length > 0,
    "撞墙文案必须登记，否则风控会被误报成超时",
  );
  assert.ok(
    wenxinWebProfile.quota.exhaustedPatterns.some((p) => p.test("百度安全验证 请完成下方验证后继续操作")),
    "必须能识别实测到的滑块验证页文案",
  );
  assert.ok(
    wenxinWebProfile.quota.exhaustedPatterns.some((p) => p.test("拖动左侧滑块使图片为正")),
  );

  // 节奏：撞墙记录来自连续 15 题的探测批次，不是单题频率。匿名面撞墙的代价是白烧整轮预算，
  // 间隔不应低于 60 秒。量级保守是因为恢复要等平台自行放行，硬顶只会把剩下的问题烧掉。
  assert.ok(
    wenxinWebProfile.limits.minDelayMs >= 60_000,
    "匿名面撞墙的代价是白烧，间隔不应低于 60 秒",
  );
  assert.deepEqual(collectProfileErrors(wenxinWebProfile), []);
});

/**
 * 文心一言 profile 的实测取值（`docs/WENXIN_PHASE0.md`）。
 *
 * 每一处都对应一个「填错了不会报错、只会静默采错」的地方，所以逐条钉住。
 */
test("wenxin profile carries the measured selectors, not plausible-looking ones", () => {
  // 输入框实测带稳定 id：textarea#chat-textarea，类名 ci-textarea ci-scroll-style。
  //
  // ⚠️ placeholder **绝不能**出现在任何选择器里：实测它是轮换的热点话题
  //（「肖战第1次上热搜涨粉130万」「帮我写面试自我介绍模版」「智界 RX及鸿蒙智行新品发布会」…），
  // 每次刷新都不同。选它会在第二次刷新时就失配。
  const composerText = wenxinWebProfile.chat.composerSelectors.join(" ");
  assert.equal(wenxinWebProfile.chat.composerSelectors.length, 1);
  assert.ok(wenxinWebProfile.chat.composerSelectors[0].startsWith("textarea#"));
  assert.doesNotMatch(composerText, /placeholder/i);

  // ⚠️ 答案选择器必须带 ai-markdown 这一位排他。实测同一轮里
  //   ai-entry-block.ai-thinking-steps  834-942 字符
  //   ai-entry-block.ai-markdown        62-235 字符
  // 两者是兄弟节点、共用 ai-entry-block 类名，思考块是答案的数倍。
  // 简化成 `.ai-entry-block` 或「取最长文本块」会**稳定地**采到搜索步骤，
  // 而且 status=success —— 这是本平台最危险的静默损坏。
  assert.ok(
    wenxinWebProfile.chat.answerSelectors.every((sel) => /ai-markdown/.test(sel)),
    "答案选择器必须带 ai-markdown 排他位，否则思考块会被当成答案",
  );
  // 任何含 ai-entry-block 的选择器都必须紧跟 ai-markdown 排位，否则 querySelectorAll
  // 会把思考块一起收进来，取最后一个就可能取到它（思考块在 DOM 里排在答案块之前）。
  for (const sel of wenxinWebProfile.chat.answerSelectors) {
    const index = sel.indexOf("ai-entry-block");
    if (index < 0) continue;
    const rest = sel.slice(index + "ai-entry-block".length);
    assert.match(
      rest,
      /^[\s]*[.\[]?\s*ai-markdown/,
      `选择器 ${sel} 里的 ai-entry-block 后面必须紧跟 ai-markdown 排位`,
    );
  }

  // 提问气泡：对话内是 cs-question-bubble。页面里同一段文字在历史栏也出现 16 处
  // （chat-side-list-item / history-item-content / history-item-text），历史栏跨会话累积，
  // 锚到它会读到上一轮的提问。
  assert.ok(
    wenxinWebProfile.chat.userBubbleSelectors.some((sel) => /cs-question-bubble/.test(sel)),
  );
  assert.ok(
    !wenxinWebProfile.chat.userBubbleSelectors.some((sel) => /history-item|chat-side-list/.test(sel)),
    "历史栏的提问副本会读到上一轮，不能作为用户气泡",
  );

  // 发送控件在实测里**提取不到**（send btns 恒为空数组），Enter 是唯一测通的提交路径。
  // sendSelectors 在 profile.js 里是必填项，指向输入框是准确的：焦点在框内按 Enter 就是实测路径。
  assert.deepEqual(wenxinWebProfile.chat.sendSelectors, ["textarea#chat-textarea"]);

  // 匿名面：实测 cookie 只有 BAIDUID / H_WISE_SIDS / BA_HECTOR / ZFY，全是设备标识与埋点类，
  // 没有承载登录语义。写进 sessionCookies 就会重演豆包「CSRF cookie 当凭证」那次事故。
  assert.equal(wenxinWebProfile.requiresStoredAuth, false);
  assert.deepEqual(wenxinWebProfile.login.sessionCookies, []);

  // 入口是真实服务域名。yiyan.baidu.com 与 chat.baidu.com 实测都会 302 到这里，
  // 用它们会多一跳重定向，且风控判定里拿到的 host 与实测墙的 host 不一致。
  assert.equal(wenxinWebProfile.entryUrl, "https://wenxin.baidu.com/");

  // 空数组是「还没量到」的诚实表达，不是遗漏：14 轮从未出现登录墙；
  // 实测在生成期间也**没有任何**停止/暂停控件，所以 inProgressPatterns 无从填起，
  // driver 只能用「答案块长度连续多轮不再增长」作为唯一完成出口。
  assert.deepEqual(wenxinWebProfile.login.loginSurfaceSelectors, []);
  assert.deepEqual(wenxinWebProfile.chat.inProgressPatterns, []);
  assert.equal(wenxinWebProfile.chat.busyWhenSendMissing, undefined);
  // 14 轮 URL 始终停在根路径，会话状态只在页面内（不进路径），没有可回查的 conversationId。
  assert.equal(wenxinWebProfile.chat.conversationUrlPattern, null);

  // 引用口径：平台自陈「共参考N篇资料」/「搜索全网N篇资料」，可与解析到的条目数对账。
  assert.equal(wenxinWebProfile.citation.tier, "self-reported-count");
  assert.ok(wenxinWebProfile.citation.countPattern.test("搜索3个关键词 共参考22篇资料"));
  assert.ok(wenxinWebProfile.citation.countPattern.test("搜索全网32篇资料"));
  // 引用条目实测不含任何 <a>，URL 在 data 属性里 —— 所以 blockSelectors 指向条目本身。
  assert.ok(wenxinWebProfile.citation.blockSelectors.some((sel) => /reference-item/.test(sel)));
});

test("the wenxin adapter is wired to the real driver, not a stub", async () => {
  assert.equal(typeof wenxinWebProvider.openPage, "function");
  assert.equal(typeof wenxinWebProvider.run, "function");
  assert.equal(wenxinWebProvider.profile, wenxinWebProfile);
  // 没有 page 就必须立刻失败：返回一个假的 page 会让采集器以为已经打开页面，
  // 后续每一步都在 undefined 上操作，报错点被推迟到很难定位的地方。
  await assert.rejects(() => wenxinWebProvider.openPage(undefined, {}, wenxinWebProfile), TypeError);
});

/**
 * 完成判据：文心的答案是**反复整块重写**，不是流式增长。
 *
 * 这一条单独成组，因为它挡住的是最危险的一类损坏：**看起来完全正常的截断**。
 * 第一版 driver 用「答案长度连续 3 轮不再增长」收尾，实测长度序列是
 * 116 → 40 → 9 → 115 → 134 → 36 → 19 → 41 —— 3 轮稳定落在中间态上，
 * 于是收下了 41 字符的**平台收尾追问句**
 * 「需要我为你规划一条西湖区一日游经典路线吗？」当成答案。
 *
 * 它通过了当时所有的检查：相关、有引用、引用数与自陈数对得上、status=success。
 * 只有一个"完成来源"字段能抓住它 —— 这就是下面这些断言存在的理由。
 */
test("wenxin's completion signal is the follow-up chips, not length stability", () => {
  // 追问气泡是 driver 判完成的依据，它必须是**实测存在**的类名。
  // 实测（探针 15）：提问后 29.1 秒内恒为 0，t=29.6s 与答案冻结同帧出现，之后恒定。
  assert.ok(
    wenxinWebProfile.chat.answerSelectors.length > 0,
    "答案选择器必须存在（回归钉子）",
  );

  // `chat.inProgressPatterns` 留空是**实测结论**，不是遗漏：
  // 14 轮里停止/暂停控件恒为 0 次出现，正文也从不出现「生成中/停止生成/思考中」。
  // 曾经在这里写启发式（`[class*='loading']`），结果假阳性让每轮都白等 60 秒。
  assert.deepEqual(wenxinWebProfile.chat.inProgressPatterns, [],
    "文心没有在生成文案；写没测过的启发式只会制造假阳性");

  // 注册闸门本身不能被这次改动削弱：driver 仍要接到真实实现。
  assert.equal(getProviderAdapter("wenxin").id, "wenxin-web");
});

/**
 * 撞墙形态：文心的风控是**导航**，不是原地替换。
 *
 * 与智谱那条断言并列，因为处置不同：智谱留在原地（textarea 压成 0x0），
 * 文心直接跳到 `wappass.baidu.com/static/captcha/tuxing_v2.html`，textarea 从 DOM 消失。
 * 所以判墙必须看 URL 与正文，任何"输入框在不在"的判据在文心都只会得到"页面变了"。
 */
test("wenxin's wall is a cross-host navigation, so the composer disappears entirely", () => {
  // 墙的文案逐字实测，必须都能认出来。
  const walls = [
    "百度安全验证 请完成下方验证后继续操作",
    "拖动左侧滑块使图片为正",
    "请完成下方验证后继续操作",
  ];
  for (const text of walls) {
    assert.ok(
      wenxinWebProfile.quota.exhaustedPatterns.some((p) => p.test(text)),
      `必须能识别实测到的墙文案：${text}`,
    );
  }
  // 撞墙后不能重试到底：所以这些文案要能被识别成「等平台放行」而不是「再试一次」。
  // （这一点由 driver 抛 VERIFICATION_REQUIRED 承担，profile 只负责认出来。）

  // 匿名面：14 轮从未出现登录墙，所以 loginSurfaceSelectors 必须留空 ——
  // 写一个没见过的选择器会在真撞墙时静默失配。
  assert.deepEqual(wenxinWebProfile.login.loginSurfaceSelectors, []);
});
