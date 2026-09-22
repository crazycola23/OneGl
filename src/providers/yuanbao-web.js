import { CITATION_TIERS } from "./profile.js";

/**
 * 腾讯元宝 Web.
 *
 * NOT VALIDATED. Every measured field below is deliberately empty; `tools/provider-phase0.js`
 * fills them from a live capture, and `src/providers/index.js` refuses to register a profile
 * that has not been through it. Do not populate these by analogy with Doubao.
 *
 * Known from the public entry point only: the site is https://yuanbao.tencent.com/chat and
 * login is QR-driven (WeChat / QQ), which is why this platform was chosen first - a QR flow
 * completes through the existing remote-auth screenshot-polling surface without opening any
 * arbitrary-input channel.
 */
export const yuanbaoWebProfile = {
  id: "yuanbao-web",
  provider: "yuanbao",
  model: "yuanbao",
  access: "scraped",
  entryUrl: "https://yuanbao.tencent.com/chat",

  validated: false,
  requiresStoredAuth: true,

  login: {
    // Phase 0: anonymous-vs-logged-in cookie diff. Nothing here may be a CSRF or telemetry
    // token, so nothing here may be guessed.
    sessionCookies: [],
    captchaPatterns: [],
    restrictedPatterns: [],
    qrExpiredPatterns: [],
    qrRefreshCandidates: [],
    loginSurfaceSelectors: [],
  },

  chat: {
    composerSelectors: [],
    sendSelectors: [],
    answerSelectors: [],
    inProgressPatterns: [],
    // Without this, the prompt we typed counts as the answer and brand detection fires on
    // our own question.
    userBubbleSelectors: [],
    conversationUrlPattern: null,
  },

  citation: {
    // 元宝是否自陈引用数量尚未观测过。dom-only 是安全的缺省：只声明抓到了什么，
    // 不声明抓全了。
    tier: CITATION_TIERS.DOM_ONLY,
    countPattern: null,
    blockSelectors: [],
    wrapperRedirectHosts: [],
  },

  networkEvidence: {
    // Passive retrieval evidence stays opt-in and per-platform; 元宝's stream endpoints are
    // unknown until captured.
    requestUrlPatterns: [],
    conversationIdPatterns: [],
  },

  limits: {
    minDelayMs: 30_000,
    maxDelayMs: 90_000,
    hourlyLimit: 10,
    dailyLimit: 40,
  },
};
