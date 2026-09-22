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
  assert.deepEqual(listProviderAdapters().map((entry) => entry.id), ["doubao-web", "qianwen-web"]);
  assert.throws(() => getProviderAdapter("yuanbao"), /Unsupported provider adapter/);
  assert.deepEqual(pendingProviderProfiles.map((entry) => entry.id), ["yuanbao-web", "qianwen-web"]);
  // 公开枚举由 adapter 表推导，客户端不可能拿到采集端跑不了的平台。
  assert.deepEqual(supportedProviderIds(), ["doubao", "qianwen"]);
});

test("the registration gate is the profile's validated flag and nothing else", () => {
  assert.deepEqual(
    selectRegistrableAdapters([doubaoWebProvider, qianwenWebProvider]).map((a) => a.id),
    ["doubao-web", "qianwen-web"],
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

test("an anonymous surface is judged on quota, not on a login it will never have", () => {
  const gaps = collectProfileErrors(qianwenWebProfile);
  const warnings = collectProfileWarnings(qianwenWebProfile);
  assert.equal(qianwenWebProfile.requiresStoredAuth, false);
  // No session to measure, so no cookie list may be demanded of it.
  assert.equal(gaps.some((entry) => entry.includes("login.sessionCookies")), false);
  // Everything the driver reads has been observed, so nothing integrity-critical is missing.
  assert.deepEqual(gaps, []);
  // The unobserved cap copy is reported, but it costs explanation rather than correctness:
  // a spent allowance surfaces as a timeout that will not retry, not as a wrong sample.
  assert.deepEqual(warnings, [
    "qianwen-web.quota.exhaustedPatterns must be a non-empty array of strings",
  ]);

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
