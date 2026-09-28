import { executeZhipuPrompt, openZhipu } from "../zhipu.js";
import { normalizeProviderResult, PROVIDER_ACCESS } from "./contract.js";
import { CITATION_TIERS } from "./profile.js";

/**
 * 智谱清言 Web（智谱 AI，入口 chatglm.cn）—— 匿名面。
 *
 * ## Phase 0 已跑通
 *
 * 2026-09-27 在本地 Camoufox 出货引擎跑过 anonymous + chat 两轮，匿名提问端到端成功。
 * 完整测量记录见 `docs/ZHIPU_PHASE0.md`；driver 见 `src/zhipu.js`。
 *
 * ## 三个实测障碍与各自的处置
 *
 * 1. **新手引导弹层盖住输入框。** `el-dialog.claw-guide-dialog` 的关闭按钮
 *    `button.close-btn` 既无文字也无 aria-label，按可见文字找的兜底必然失配 ——
 *    这就是 `MULTI_PLATFORM_LESSONS.md` §2 记的「兜底链里有一档会假成功，
 *    整条链的语义就废了」。driver 用四条独立路径尝试关闭，并**验证 overlay
 *    真的消失**才继续，不假设点击生效了。
 *
 * 2. **输入框没有稳定标识。** `textarea` 无 placeholder / 无 aria-label /
 *    无 data-testid，类名 `scroll-display-none` 是工具类，`data-v-642ee465`
 *    是每次构建都变的 Vue scoped 哈希。driver 用标签 + 弹层校验双重兜底。
 *
 * 3. **答案容器没有类名，且页脚更长。** 答案是裸 `<p>`，同页 `policy-wrap`
 *    页脚实测 101 字符、答案只有 54 字符。按「最长文本块」取答案会**稳定地**
 *    读到页脚，让引用数与回答完整性同时失真，而且看起来是成功的 ——
 *    这类错误比直接失败危险。driver 因此按「问题气泡之后的段落」定位，
 *    并显式排除页脚容器。
 *
 * ## 与 GEO 侧的约定
 *
 * provider 码 `zhipu`、adapter id `zhipu-web`，两端逐字一致。GEO 侧
 * `OneGlPlatforms.codeOf("ONEGL-ZHIPU")` 翻译出的 `platforms: ["zhipu"]` 必须能命中本
 * adapter，否则 422。
 */
export const zhipuWebProfile = {
  id: "zhipu-web",
  provider: "zhipu",
  model: "zhipu",
  access: "scraped",
  entryUrl: "https://chatglm.cn/",

  // Phase 0 已在本地 Camoufox 出货引擎跑过 anonymous + chat 两轮（2026-09-27），
  // 匿名提问端到端成功。测量记录见 docs/ZHIPU_PHASE0.md。
  //
  // 之前这里刻意是 false，理由是「答案容器没有稳定标识、同页页脚比答案更长」。
  // 现在可以打开，因为 src/zhipu.js 正面解决了这个问题：答案定位走
  // 「问题气泡之后的段落」这一结构关系，并显式排除 .policy-wrap 等页脚容器。
  // 那条限制已经由 driver 承担，而不是被绕过。
  //
  // 2026-09-28 补充实测：真实批量下撞到「访问验证」风控页（textarea 尺寸 0x0）。
  // 撞墙文案已登记进 quota.exhaustedPatterns，driver 也改为先判墙再判弹层，
  // 撞墙抛 VERIFICATION_REQUIRED（不可重试、阻断），不再当页面结构错乱连打三次。
  validated: true,
  requiresStoredAuth: false,

  login: {
    // 2026-09-27 实测（.onegl/phase0/zhipu-web.anonymous.json）：
    // 匿名访问 chatglm.cn 得到 6 个 cookie —— chatglm_token / chatglm_token_expires /
    // chatglm_refresh_token / chatglm_user_id / ssxmod_itna / ssxmod_itna2，
    // **值全部为空字符串**。它们是占位名而非登录凭据：pageText 里同时出现「登录」
    // 入口和「访客_5bd9cf」身份标记，说明这一轮确实处在未登录状态。
    // 因此 sessionCookies 保持空数组是对的：匿名面没有会话可测，
    // 硬把这六个名字写进来只会重演豆包「CSRF cookie 当凭证」那次事故。
    sessionCookies: [],
    // 未观测到验证码 / 限制页特征，不填。
    captchaPatterns: [],
    restrictedPatterns: [],
    qrExpiredPatterns: [],
    qrRefreshCandidates: [],
    // 2026-09-27：anonymous 与 chat 两轮均未出现登录墙（loginWallObserved=false），
    // 匿名额度尚未触顶。墙长什么样未观测，所以这里不写任何选择器——
    // 写一个没见过的选择器，比留空更危险：它会在真撞墙时静默失配。
    loginSurfaceSelectors: [],
  },

  chat: {
    // 实测：唯一的可编辑元素是 <textarea rows="1" autofocus>，
    // 无 placeholder、无 aria-label、无 data-testid，唯一类名是
    // `scroll-display-none`（工具类，作用是隐藏滚动条），
    // 另有一个 Vue scoped 属性 data-v-642ee465（每次构建都会变）。
    // 两者都不是稳定标识：`phase0.js` 明确拒绝构建哈希类，
    // MULTI_PLATFORM_LESSONS.md §1 记着豆包 qrcode-DeN5Ny 换构建就选不中的事故。
    // 这里用 `textarea` 作为标签级兜底 —— 页面实测只有这一个可编辑元素，
    // 配合下面的 answerSelectors 的位置约束一起用。
    composerSelectors: ['textarea'],
    // 实测：发送控件是纯 SVG 图标，无 class、无 aria-label、无文字，
    // 文本类名启发式完全提不出来。可靠的发送方式是键盘 Enter
    // （chat 轮实测 Enter 成功提交并拿到完整回答）。
    // 仍要填一个值：sendSelectors 在 profile.js 里是必填项，留空会让 profile 校验不过。
    // 指向输入框是准确的——焦点在输入框时按 Enter 就是实测通过的提交路径，
    // driver 不应把它当成「点这个按钮」。
    sendSelectors: ["textarea"],
    // 实测的硬限制：回答正文是裸 <p>，**没有任何类名**。
    // 同页可稳定识别的只有问题气泡 `.question-txt`（问题侧有类名，答案侧没有）。
    // 这里用「问题气泡之后、且不含问题类名的段落」这一结构关系来定位，
    // 而不是编一个不存在的答案类名。
    answerSelectors: ['[class*="question-txt"] ~ * p', '.chat-message p', 'p'],
    // 2026-09-27 实测到的完成信号是「思考结束」出现在正文流末尾。
    inProgressPatterns: [/思考中/],
    // 缺了它会把我们自己提的问题当成平台的回答 —— 这一条实测有效：
    // `.question-txt` 稳定命中用户气泡（classTokens:
    // fs14,flex1,ft_grey3,question-txt,dots,wrap,pr,dot-5-line）。
    userBubbleSelectors: ['[class*="question-txt"]'],
    // 2026-09-27 实测 URL 始终停在 /main/alltoolsdetail?lang=zh，
    // 未观察到会话 id 进入路径，因此不写 pattern（不猜）。
    conversationUrlPattern: null,
    // 未验证「发送控件在生成期间是否消失」，不声明。
    busyWhenSendMissing: undefined,
  },

  citation: {
    // 2026-09-27 第二次实测（带检索的问题）推翻了第一次的结论：
    // 智谱**会**自陈来源数量，句式是「N个来源」（实测「19个来源」「10个来源」）。
    // 所以可以从 DOM_ONLY 升到 SELF_REPORTED_COUNT —— 能与解析到的域名数对账，
    // 数量不等时下游标 partial，而不是悄悄按抓到的数量出数。
    //
    // 第一次实测之所以判 DOM_ONLY，是因为问题太短（54 字自述）根本没触发检索。
    // 「没观测到」和「不存在」是两回事 —— 前者不能当后者用。
    tier: CITATION_TIERS.SELF_REPORTED_COUNT,
    countPattern: /(\d+)\s*个来源/,
    // 来源是**裸域名角标**（askci.com / lbkrs.com / biggo.com.tw），不是 <a> 标签：
    // 实测 querySelectorAll("a[href^='http']") 恒为 0。所以没有可点击的来源块选择器，
    // driver 改为从答案正文里解析域名，url 一律为 null —— 伪造 URL 比留空更糟，
    // 下游会把它当成一条可回查的证据。
    blockSelectors: [],
    wrapperRedirectHosts: [],
  },

  networkEvidence: {
    // 未捕获流式端点，保持关闭。
    requestUrlPatterns: [],
    conversationIdPatterns: [],
  },

  quota: {
    // 2026-09-28 实测撞到「访问验证」页：正文为
    // 「访问验证 别离开，为了更好的访问体验，请进行验证，通过后即可继续访问网页」，
    // 页面里 textarea 仍在 DOM 但尺寸 0x0。登记在这里是**必需**的 ——
    // MULTI_PLATFORM_LESSONS.md §4：撞墙认不出来就只能记成 TIMEOUT，报告和告警
    // 读不出真相，而真相需要「等平台放行」这个完全不同的处置。
    exhaustedPatterns: [/访问验证/, /请进行验证/, /滑动验证/],
    // 实测：一次干净会话成功提问并拿到完整回答，未观察到同会话内第二条会失真。
    // 取 1 = 每问换一个干净上下文，与豆包 / 千问同口径：同会话追问测的是
    // 「追问后的可见性」，会人为抬高引用率与提及率。
    promptsPerWindow: 1,
    // 未观测到「问了但没回」的情形，保持与千问同一起步值。
    suspectedIdleMs: 120_000,
    // 已实测有效：这一句能拿到简短稳定的自述回答（54 字），
    // 便于识别「额度用尽」与「风控拦截」——两者需要相反的处置。
    controlPrompt: "你好，请用一句话介绍你自己。",
  },

  limits: {
    // 2026-09-28 实测：单题间隔 15-33 秒时连续 9 次全部成功；
    // 紧接着跑一个 4 题批次立刻撞上访问验证墙。**失败的分界线是连续提问的累积量，
    // 不是单题频率** —— 与千问「当天累计约 37 次后弹登录墙」同形
    // （docs/MULTI_PLATFORM_LESSONS.md §4）。
    //
    // ⚠️ **这些值当前不会被消费。** accounts/safety.js 只读全局的
    // ONEGL_MIN_DELAY_MS / ONEGL_MAX_DELAY_MS / ONEGL_ACCOUNT_HOURLY_LIMIT /
    // ONEGL_ACCOUNT_DAILY_LIMIT；代码里不存在对 profile.limits 的引用
    // （doubao-web.js 也没有这个字段）。保留它是为了记录实测结论和将来的意图，
    // **不是**当前生效的配置 —— 声称它生效会让人以为调平台节奏只需改这里。
    //
    // 当前生效的是全局值，已按本次实测调到 60-120 秒 / 小时 6 / 日 20。
    minDelayMs: 60_000,
    maxDelayMs: 120_000,
    hourlyLimit: 6,
    dailyLimit: 20,
  },
};

/**
 * 智谱清言的采集适配器，接到 src/zhipu.js 的真实 driver。
 *
 * 注册闸门就是 profile 的 `validated` 标志：翻成 false 会让整个 adapter 从
 * providers/index.js 的表里消失（症状是 `Unsupported provider adapter: "zhipu"`，
 * 而不是一条清晰的校验错误），公开枚举也由那张表推导，所以「API 接受这个平台」
 * 与「采集器真能跑它」不会脱节。
 */
export const zhipuWebProvider = {
  id: "zhipu-web",
  provider: "zhipu",
  model: "zhipu",
  access: "scraped",
  profile: zhipuWebProfile,
  requiresStoredAuth: false,

  openPage(page, config) {
    return openZhipu(page, config, zhipuWebProfile);
  },

  async run({ page, prompt, config }) {
    const raw = await executeZhipuPrompt(page, prompt, config, zhipuWebProfile);
    return normalizeProviderResult(
      {
        ...raw,
        textContent: raw.answer,
        rawOutput: raw,
        webQueries: [],
      },
      {
        provider: zhipuWebProfile.provider,
        model: zhipuWebProfile.model,
        access: zhipuWebProfile.access,
      },
    );
  },
};
