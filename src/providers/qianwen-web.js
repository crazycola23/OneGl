import { CITATION_TIERS } from "./profile.js";

/**
 * 千问 Web（阿里，原通义千问，入口 www.qianwen.com）。
 *
 * NOT VALIDATED. Every measured field is deliberately empty; `tools/provider-phase0.js` fills
 * them from a live capture and `registerProviderProfile` refuses the profile until then.
 *
 * This is the platform's *anonymous* surface: `requiresStoredAuth: false` means no login
 * state, no account row and no session cookie list. That choice is load-bearing in two
 * directions, and both have to stay visible in the data:
 *
 * 1. An anonymous answer is a different surface from a logged-in one - typically shallower
 *    retrieval and different citation presentation. So a sample measured this way can never
 *    be pooled with account samples in the same rate or uplift number. It needs its own
 *    partition in every report, or the citation analytics stop describing anything real.
 * 2. The window rotation below resets conversation state only. It does not create a new
 *    visitor: Camoufox fixes the fingerprint at launch and there is no egress proxy wired in
 *    (`src/browser.js` passes no `proxy`), so minting windows in a loop to refill the free
 *    quota would present as one machine pretending to be several people, and the block that
 *    earns is an IP block shared with the Doubao accounts on the same egress. Cap reached
 *    therefore means back off and report, never rotate identity.
 */
export const qianwenWebProfile = {
  id: "qianwen-web",
  provider: "qianwen",
  model: "qianwen",
  access: "scraped",
  entryUrl: "https://www.qianwen.com/",

  validated: false,
  requiresStoredAuth: false,

  login: {
    // No session to measure. These three lists still matter: they are what separates
    // "free quota used up" from "risk control", and the two need opposite responses.
    //
    // 匿名实测（2026-09-22）落下的 10 个 cookie 全部是 CSRF/埋点类，没有一个承载登录语义：
    //   xsrf-token, um_distinctid, cnzzdata*, b-user-id, __itrace_wid, theme-mode, cna,
    //   isg, tfstk, xlly_s
    // 也就是说匿名首页确实可用（未出现登录墙），但也确实没有会话；把其中任何一个当凭证
    // 都会重演豆包「未扫码也绑定成功」那次事故。
    sessionCookies: [],
    captchaPatterns: [],
    restrictedPatterns: [],
    qrExpiredPatterns: [],
    qrRefreshCandidates: [],
    loginSurfaceSelectors: [],
  },

  chat: {
    // 以下两项是 2026-09-22 用 tools/provider-phase0.js 对 www.qianwen.com 匿名实测出来的，
    // 不是推测：composer 是 Slate 编辑器，带 data-slate-editor="true" 与
    // data-placeholder="向千问提问"（选前者，因为文案会被产品改）；发送按钮在输入前不存在，
    // 输入后出现，稳定标识是 data-session-switch-target="send-query"，
    // aria-label="发送消息"，且没有显式 role 属性。
    composerSelectors: ['[data-slate-editor="true"]'],
    sendSelectors: ['[data-session-switch-target="send-query"]'],
    // 未测出：匿名提交在探针里没走通 —— 首页有个「工作助理再升级」营销浮层（localStorage
    // 键 qianwen_promotion_modal_frequency_v1 控制频控），它会占住指针并吃掉回车；强制点击后
    // 发送按钮仍是禁用态（class 含 cursor-not-allowed 与 --ty-text-disabled）。
    // 所以下面三项保持为空，档案也就保持 unvalidated。
    answerSelectors: [],
    inProgressPatterns: [],
    userBubbleSelectors: [],
    conversationUrlPattern: null,
  },

  /** 匿名浮层与干扰项，driver 必须先清掉再判定会话状态。 */
  interstitials: {
    modalTextPatterns: [/工作助理再升级|立即体验/],
    dismissSelectors: ['button:has-text("关闭")'],
  },

  /**
   * Quota handling for an unauthenticated surface. Tier order matters and is enforced in the
   * driver, not hoped for:
   *
   *   explicit copy  -> QUOTA_EXHAUSTED, back off to the stated reset point
   *   no answer delta + composer disabled -> QUOTA_SUSPECTED, slow down only
   *   control prompt also fails -> ACCESS_RESTRICTED / VERIFICATION, halt and alert
   *
   * The third case is why the control prompt exists. Without it a risk-control page reads as
   * "quota spent", and the campaign then sleeps until midnight instead of escalating.
   */
  quota: {
    promptsPerWindow: 3,
    exhaustedPatterns: [],
    suspectedIdleMs: null,
    controlPrompt: null,
  },

  citation: {
    // Untested whether 千问 states a source count to anonymous visitors. dom-only until then.
    tier: CITATION_TIERS.DOM_ONLY,
    countPattern: null,
    blockSelectors: [],
    wrapperRedirectHosts: [],
  },

  networkEvidence: {
    requestUrlPatterns: [],
    conversationIdPatterns: [],
  },

  limits: {
    // Deliberately no higher than the account path. Being anonymous is not a licence to
    // raise the rate; it lowers what we can justify.
    minDelayMs: 30_000,
    maxDelayMs: 90_000,
    hourlyLimit: 6,
    dailyLimit: 20,
    windowCooldownMs: 60_000,
  },
};
