import assert from "node:assert/strict";
import test from "node:test";

import {
  isHashBearingClass,
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
  deriveSessionCookieCandidates,
} from "../src/providers/profile.js";
import {
  getProviderAdapter,
  listProviderAdapters,
  pendingProviderProfiles,
  providerProfileGaps,
  registerProviderProfile,
} from "../src/providers/index.js";
import { yuanbaoWebProfile } from "../src/providers/yuanbao-web.js";

test("build-hash class names are never turned into selectors", () => {
  // 豆包远端登录踩过这个：qrcode-DeN5Ny 换个构建就选不中了。
  assert.equal(isHashBearingClass("qrcode-DeN5Ny"), true);
  assert.equal(isHashBearingClass("css-1a2b3c"), true);
  assert.equal(isHashBearingClass("md-box-root"), false);
  assert.equal(suggestSelector({ classTokens: ["qrcode-DeN5Ny"] }), '[class*="qrcode"]');
  assert.equal(suggestSelector({ classTokens: ["md-box-root", "foo"] }), ".md-box-root");
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
    suggestSelectors([{ testid: "a" }, { testid: "a" }, { testid: "b" }]),
    ['[data-testid="a"]', '[data-testid="b"]'],
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

test("a pending profile is not reachable as an adapter, validated or not", () => {
  assert.deepEqual(listProviderAdapters().map((entry) => entry.id), ["doubao-web"]);
  assert.throws(() => getProviderAdapter("yuanbao"), /Unsupported provider adapter/);
  assert.deepEqual(pendingProviderProfiles.map((entry) => entry.id), ["yuanbao-web"]);

  // Even a profile marked validated stays unregistered while its measurements are missing.
  assert.throws(
    () => registerProviderProfile({ ...yuanbaoWebProfile, validated: true }, async () => ({})),
    /is incomplete/,
  );
  assert.equal(registerProviderProfile(measuredProfile(), async () => ({ citations: [] })).id, "yuanbao-web");
  assert.equal(getProviderAdapter("yuanbao").id, "yuanbao-web");
});

// A profile with every measured field filled in, i.e. what Phase 0 is supposed to produce.
function measuredProfile() {
  return {
    ...yuanbaoWebProfile,
    validated: true,
    login: {
      ...yuanbaoWebProfile.login,
      sessionCookies: ["qq_domain_video_gsauth2"],
      captchaPatterns: [/滑动验证/],
      restrictedPatterns: [/访问异常/],
      qrExpiredPatterns: [/二维码已失效/],
    },
    chat: {
      ...yuanbaoWebProfile.chat,
      composerSelectors: ['[contenteditable="true"]'],
      sendSelectors: ['[aria-label="发送"]'],
      answerSelectors: [".answer-md"],
      inProgressPatterns: [/正在搜索/],
      userBubbleSelectors: [".user-bubble"],
    },
  };
}

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
  assert.equal(collectPageSignals.length, 0);
  assert.doesNotMatch(collectPageSignals.toString(), /\b(suggestSelector|isHashBearingClass|HASH_TOKEN)\b/);
});
