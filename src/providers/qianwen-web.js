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
    // composer / send / answer 的选择器都跑过两轮实测：2026-09-22 在 Chromium 上，
    // 2026-09-23 在**真正出货的引擎**（部署容器里的 Camoufox）上重测。第二次是必须的：
    // 回答卡的类名在 Camoufox 上是 answer-common-card / qk-markdown，不再是 message-card，
    // 而采集器当时把 message-card 写死在页面扫描里，于是每次提问都读不到答案、一路拖到超时。
    composerSelectors: ['[data-slate-editor="true"]'],
    // Camoufox 实测两个都在：data-session-switch-target 与 aria-label="发送消息"。
    sendSelectors: ['[data-session-switch-target="send-query"]', '[aria-label="发送消息"]'],
    // 提问卡类名可读（message-card-wrap question），回答卡在 Chromium 上带构建哈希
    // （message-card-j_n6rq）、在 Camoufox 上叫 answer-common-card；三种都留着，取并集。
    answerSelectors: ['[class*="message-card"]', '[class*="answer-common-card"]', '[class*="qk-markdown"]'],
    userBubbleSelectors: ['[class*="message-card"][class*="question"]', '[class*="question-card-wrap"]'],
    // Camoufox 实测：回答期间**发送控件整体消失**，回答结束后回来（1→0→1）。这比「停止回答」
    // 可靠 —— 后者在实测里自始至终没有出现过（stopCount 恒为 0），拿它当完成判据等于永远等。
    busyWhenSendMissing: true,
    // 旧判据（「停止回答」消失）保留给还能命中的构建；它与 busyWhenSendMissing 是或关系。
    inProgressPatterns: [/停止回答/],
    conversationUrlPattern: /\/chat\/([a-z0-9-]{16,})/,
  },

  /** 匿名浮层与干扰项，driver 必须先清掉再判定会话状态。 */
  interstitials: {
    modalTextPatterns: [/工作助理再升级|立即体验/],
    // 实测到两种：促销浮层（有 aria-label="关闭" 的图标按钮）与首页引导轮播（没有关闭按钮，
    // 盖在输入框上拦截指针）。后者是 Radix Dialog（节点 id 形如 radix:r3n），所以除了点关闭
    // 图标，还要走它自带的遮罩层 —— 点遮罩是真人会做的动作，不是改动页面 DOM。
    dismissSelectors: [
      '[aria-label="关闭"]',
      'button:has-text("关闭")',
      "[data-radix-dialog-overlay]",
      '[role="dialog"] ~ div[class*="overlay"]',
    ],
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
    // 1, not 3. 千问的驱动没有豆包那种「提问前先点新对话」的动作，而一个窗口里的第二个问题
    // 会落在同一个对话上下文中 —— 那测的就不再是"独立提问下的可见性"，而是"就刚才的话题
    // 追问一句之后的可见性"，第二轮答案更容易重复提到第一轮的品牌，引用率被人为抬高。
    // 每问换窗口用已有的 rotateContext（保留 cookie、复用浏览器进程）拿到干净会话，
    // 同时避免高频重启 Camoufox 踩孤儿进程树那个坑。
    promptsPerWindow: 1,
    // 2026-09-22 的 6 次匿名提问没看到任何上限文案，于是这一项当时留空、只记一条告警。
    // 2026-09-23 跑第 4 条真实批量时墙出现了：当天累计约 37 次匿名提问后，页面弹「登录解锁
    // 完整功能」（手机号/验证码 + 二维码，二维码本身已「扫描失败」），盖住整页。此时提问仍被
    // 送进对话（artifact 里 promptEchoCount=1），但平台不再产出任何正文，于是每一次都拖满
    // 480s 才以 TIMEOUT 收场 —— 连续三次，共 24 分钟，全部记成"超时"而不是"额度用尽"。
    // 6 次采样太少，把"没看到墙"当成了"没有墙"。现在按实测文案判定：命中即 RATE_LIMITED，
    // 秒级失败并给出真实原因，不再让每次尝试白烧 8 分钟。
    // 注意它同时是一条平台自述的上限：匿名额度过期意味着这条通道当天已经用完，继续换窗口
    // 追问不会恢复额度（同一出口 IP 上的豆包账号也会跟着吃风险），所以撞墙后应当退避。
    exhaustedPatterns: ["登录解锁完整功能"],
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
