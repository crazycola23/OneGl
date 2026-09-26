import { executeQianwenPrompt, openQianwen } from "../qianwen.js";
import { intEnvValue } from "../accounts/safety.js";
import { normalizeProviderResult, PROVIDER_ACCESS } from "./contract.js";
import { CITATION_TIERS } from "./profile.js";

/** 千问匿名额度的实测静置时长（2026-09-23/24 四轮批次）。 */
const QIANWEN_BURST_PAUSE_MS_DEFAULT = 25 * 60_000;

/**
 * 平台那轮额度用尽后要静置多久，0 = 不静置（取消这条限制）。
 *
 * 单独成函数而不是写成模块常量：值是每次判定时现读的，所以改环境变量重启进程即可生效，
 * 也避免把「默认 25 分钟」这个实测事实埋进一个看不出来源的数字里。
 */
function qianwenBurstPauseMs() {
  return intEnvValue("ONEGL_QIANWEN_BURST_PAUSE_MS", QIANWEN_BURST_PAUSE_MS_DEFAULT, 0);
}

/**
 * 千问 Web（阿里，原通义千问，入口 www.qianwen.com）。
 *
 * Measured with tools/provider-phase0.js. The 2026-09-22 baseline of six anonymous captures has
 * been invalidated since: four of its `success` runs were 7-second captures whose page contained
 * zero answer nodes, so the values in `login` and `citation` are observations still awaiting a
 * re-measurement, while `chat` rests on the 2026-09-23 re-measurement on the shipped engine. See
 * docs/QIANWEN_BASELINE_INVALIDATION.md. Rolling this back is one flag: set `validated` to false
 * and the adapter leaves the table and the contract.
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
    // 2026-09-23 实测：匿名额度用尽后平台挂出的登录墙，其标题与表单在**跨域 iframe** 里
    // （passport.qianwen.com/havanaone/login/login.htm），页面正文文本读不到，所以只能用
    // DOM 判定。该 iframe 只在墙出现时才注入：墙上的 run 里出现 1 次，健康 run（含紧邻的
    // 成功样本）里 0 次。命中即 LOGIN_REQUIRED —— 秒级失败，不再白烧 480s 超时。
    loginSurfaceSelectors: ['iframe[src*="passport.qianwen.com"]'],
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
    // 2026-09-23/24 观察到「成功 3~4 条后撞登录墙」，当时据此推断匿名额度按轮给，于是设了
    // burstPrompts/burstPauseMs 把一轮钉在 4 条。
    //
    // 2026-09-26 复核：这个推断是**同一个浏览器会话连续提问**下的观测，而现在每 2 条就换指纹
    // 换窗口，前提已经变了；生产也用 ONEGL_QIANWEN_BURST_PAUSE_MS=0 把这条限制关掉了。
    // 值留在这里只是因为可用性判定还在读它 —— 它记录的是一段历史观测，不是「平台一定按轮限额」
    // 的结论。拿它去解释一次新的超时之前，先读现场信号。
    burstPrompts: 4,
    /**
     * 见上：2026-09-23 的实测值，生产已按环境变量关闭。
     *
     * 用 getter 而不是普通字段：值来自环境变量，若在模块加载时固化，测试和「改配置后想看
     * 效果」都会读到过期值 —— 校验器和运行时读的必须是同一个当下值。
     */
    get burstPauseMs() {
      return qianwenBurstPauseMs();
    },
    // 登录墙只能靠**登录面本身**判定，绝不能靠「有没有正文」。
    //
    // 2026-09-23 那次是页面弹「登录解锁完整功能」盖住整页，提问仍被送进对话
    // （promptEchoCount=1）但不再产出正文，于是拖满超时。把这条因果链写在这里的后果是：
    // 后来任何「没有正文的超时」都会被读成额度用尽。2026-09-26 就这么误判过一次 ——
    // 那批 artifact 里 login=false、captcha=false、generating=true，是平台在生成却没在
    // 预算内写完，和登录墙毫无关系。
    //
    // 「文案读不到」这一点仍然成立：墙的标题与表单在跨域 iframe
    // （passport.qianwen.com/havanaone/login/login.htm）里，document.body.innerText 一个字都没有，
    // 所以 exhaustedPatterns 留空不是遗漏。可靠信号是那个 iframe，已声明在下面
    // login.loginSurfaceSelectors；sessionSignals.login 就是由它算出来的。
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
