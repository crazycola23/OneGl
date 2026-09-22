import { executeQianwenPrompt, openQianwen } from "../qianwen.js";
import { normalizeProviderResult, PROVIDER_ACCESS } from "./contract.js";
import { CITATION_TIERS } from "./profile.js";

/**
 * 千问 Web（阿里，原通义千问，入口 www.qianwen.com）。
 *
 * Measured on 2026-09-22 over six anonymous captures with tools/provider-phase0.js; the values
 * in `login`, `chat` and `citation` are observations, not analogy with Doubao. Rolling this
 * back is one flag: set `validated` to false and the adapter leaves the table and the contract.
 *
 * This is the platform's *anonymous* surface: `requiresStoredAuth: false` means no login
 * state, no account row and no session cookie list. That choice is load-bearing in two
 * directions, and both have to stay visible in the data:
 *
 * 1. An anonymous answer is a different surface from a logged-in one. Measured here it was not
 *    a weaker one either - it ran deep search and reported "搜索 3 个关键词，参考 12 篇资料" -
 *    but that is exactly why it must not be pooled: an anonymous sample and an account sample
 *    from the same platform are two different observation conditions, and a rate or uplift
 *    number computed across both describes nobody. Every report needs its own partition.
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

  validated: true,
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
    // 以下全部是 2026-09-22 tools/provider-phase0.js 匿名实测结果，不是推测。
    composerSelectors: ['[data-slate-editor="true"]'],
    sendSelectors: ['[data-session-switch-target="send-query"]'],
    // 提问卡类名可读（message-card-wrap question），回答卡类名带构建哈希
    // （message-card-j_n6rq）。所以只能用 message-card 这个共同子串，再**排除**用户卡。
    answerSelectors: ['[class*="message-card"]'],
    userBubbleSelectors: ['[class*="message-card"][class*="question"]'],
    // 完成判据是「停止回答」按钮消失，不是文本不再增长：实测有一次深度检索阶段正文
    // 长时间只有几百字符仍在生成，用文本稳定会在空答案上收尾并把它记成真结论。
    inProgressPatterns: [/停止回答/],
    conversationUrlPattern: /\/chat\/([a-z0-9-]{16,})/,
  },

  /** 匿名浮层与干扰项，driver 必须先清掉再判定会话状态。 */
  interstitials: {
    modalTextPatterns: [/工作助理再升级|立即体验/],
    dismissSelectors: ['button:has-text("关闭")', '[aria-label="关闭"]'],
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
    // 6 次匿名提问全部拿到完整回答，未出现任何次数上限文案；页面上唯一与账号有关的文本是
    // 「登录可同步历史对话，解锁更多功能」这句提示，它不是墙。所以这一项保持为空，
    // 并按"只影响可解释性、不影响数据正确性"降级为告警：真撞上墙时该次会以 TIMEOUT
    // 失败（promptSubmitted 已知，不会重试造成重复提问），连续失败仍会走冷却与告警。
    exhaustedPatterns: [],
    suspectedIdleMs: 120_000,
    controlPrompt: "你好，请用一句话介绍你自己。",
  },

  citation: {
    // 实测：千问匿名回答会自陈「搜索 2 个关键词，参考 9 篇资料」，且带一个
    // 「已完成分析，共参考 N 篇资料」的汇总卡（容器 data-card_name="bar_workflow"）。
    // 所以它是 SELF_REPORTED_COUNT 口径，与豆包同形、能做数量对账。
    tier: CITATION_TIERS.SELF_REPORTED_COUNT,
    countPattern: /搜索\s*(\d+)\s*个关键词[，,、\s]*参考\s*(\d+)\s*篇资料/,
    blockSelectors: ['[data-card_name="bar_workflow"]'],
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

/**
 * Adapter for the measured anonymous surface. It reaches the registry only while its profile
 * reports validated, which is the gate that keeps the public enum and the collector in step.
 */
export const qianwenWebProvider = {
  id: "qianwen-web",
  provider: "qianwen",
  model: "qianwen",
  access: PROVIDER_ACCESS.SCRAPED,
  profile: qianwenWebProfile,
  requiresStoredAuth: false,

  openPage(page, config) {
    return openQianwen(page, config, qianwenWebProfile);
  },

  async run({ page, prompt, config }) {
    const raw = await executeQianwenPrompt(page, prompt, config, qianwenWebProfile);
    return normalizeProviderResult(
      {
        ...raw,
        textContent: raw.answer,
        rawOutput: raw,
        webQueries: [],
      },
      {
        provider: qianwenWebProfile.provider,
        model: qianwenWebProfile.model,
        access: qianwenWebProfile.access,
      },
    );
  },
};
