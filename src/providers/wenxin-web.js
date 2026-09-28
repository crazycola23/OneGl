import { executeWenxinPrompt, openWenxin } from "../wenxin.js";
import { normalizeProviderResult, PROVIDER_ACCESS } from "./contract.js";
import { CITATION_TIERS } from "./profile.js";

/**
 * 文心一言 Web（百度，入口 wenxin.baidu.com）—— 匿名面。
 *
 * ## Phase 0 已跑通
 *
 * 2026-09-28 在本地 Camoufox 出货引擎上跑了 14 轮探针，匿名提问端到端成功
 * （9 轮成功作答，答案 62-628 字符，引用 19-45 条）。完整测量记录见
 * `docs/WENXIN_PHASE0.md`；driver 见 `src/wenxin.js`。
 *
 * ## 入口域名先说清楚
 *
 * 官网宣传的 `yiyan.baidu.com` 与 `chat.baidu.com` **都会 302 到 `wenxin.baidu.com`**
 * （带 `?enter_type=yiyan_site` / `?enter_type=chat_site`）。真实服务域名是 wenxin.baidu.com，
 * 页面标题「百度文心助手 - 办公学习一站解决」。用 yiyan.baidu.com 作为 entryUrl 会多一跳
 * 重定向，且风控判定里拿到的 host 与实测墙的 host 不一致。
 *
 * ## 四个实测障碍与各自的处置
 *
 * 1. **答案块与思考块共用 `ai-entry-block` 类名。** 同一轮里思考块 942 字符、答案 155 字符
 *    （比例约 6:1）。按"最长文本块"取答案会**稳定地**采到搜索步骤，status=success 而内容全错
 *    —— 这就是 MULTI_PLATFORM_LESSONS.md §3 那一族。`ai-markdown` 是排他位，缺了它这条 profile 就是错的。
 *
 * 2. **风控墙是导航，不是原地替换。** 智谱把「访问验证」渲染在原地（textarea 0x0），
 *    文心是**整页跳走**到 `wappass.baidu.com/static/captcha/tuxing_v2.html`（滑块验证），
 *    textarea 从 DOM 里彻底消失。所以判墙必须看 URL 与正文，元素存在性判据全部失效；
 *    等待答案期间撞墙会让 `page.evaluate` 抛「Execution context was destroyed」，
 *    driver 把导航当数据处理而不是异常。
 *
 * 3. **引用 URL 在 data 属性里，DOM 里没有链接。** `li[class*='reference-item']` 不含任何
 *    `<a>`、没有 href（实测 22-30 条全是这样），真实地址在
 *    `data-long-press-ext-info='{"link":"https://...","linkTitle":"..."}'`。
 *    `db/persist.js` 会把缺 url 的引用整条 skip（reason=missing-url），
 *    所以只找 `<a>` 的后果是「平台自陈 23 篇资料、库里一条都没有」。这是文心与智谱的
 *    关键区别：智谱是裸域名角标（url 只能是域名根占位），文心是**完整可回查 URL**。
 *
 * 4. **重置必须点按钮，不能重新加载。** 实测重新 goto 入口页会撞上百度安全验证墙；
 *    点 `div.new-dialog-container-button` 并验证 `.ai-entry-block` 归零后连续两问正常。
 *    验证不是形式主义：不验证时探针曾把**上一题的答案**（逐字相同）当成本题回答收下。
 *
 * ## 与 GEO 侧的约定
 *
 * provider 码 `wenxin`、adapter id `wenxin-web`，两端逐字一致。GEO 侧
 * `OneGlPlatforms.codeOf("ONEGL-WENXIN")` 翻译出的 `platforms: ["wenxin"]` 必须能命中本
 * adapter，否则 422。匿名面不需要 GEO 账号绑定。
 */
export const wenxinWebProfile = {
  id: "wenxin-web",
  provider: "wenxin",
  model: "wenxin",
  access: "scraped",
  // 真实服务域名。yiyan.baidu.com / chat.baidu.com 都会 302 到这里（实测）。
  entryUrl: "https://wenxin.baidu.com/",

  // Phase 0 已在本地 Camoufox 出货引擎跑过 14 轮（2026-09-28），匿名提问端到端成功。
  //
  // 之前不敢打开的三个理由现在都不成立：
  //   - 「答案容器没有稳定标识」→ 实测 `ai-entry-block.ai-markdown` 稳定，且答案块内部干净
  //     （追问气泡、免责声明实测都在块外），不需要任何噪声过滤。
  //   - 「引用读不到」→ 实测引用 URL 在 data 属性里，22-45 条全部可解析成完整 URL。
  //   - 「撞墙后无法识别」→ 墙的形态与文案都已逐字实测，判据落在 URL 与正文上。
  validated: true,
  requiresStoredAuth: false,

  login: {
    // 2026-09-28 实测（14 轮匿名访问）：落下的 cookie 有 BAIDUID / H_WISE_SIDS / BA_HECTOR / ZFY，
    // 全部是设备标识与埋点类，**没有承载登录语义**。页面上常驻「请登录」入口与
    // 「登录同步历史对话」文案，说明这一轮确实处在未登录状态，而匿名提问**正常出答案**。
    // 因此 sessionCookies 保持空数组是对的：匿名面没有会话可测，硬把设备 cookie 写进来
    // 只会重演豆包「CSRF cookie 当凭证」那次事故。
    sessionCookies: [],
    // 未观测到验证码 / 限制页特征，**不写任何没见过的选择器**：它在真撞墙时会静默失配。
    captchaPatterns: [],
    restrictedPatterns: [],
    qrExpiredPatterns: [],
    qrRefreshCandidates: [],
    // 2026-09-28：14 轮匿名访问从未出现登录墙（滑块验证出现过，文案在 quota 里）。
    // 墙长什么样未观测，所以这里不填 —— 写一个没见过的选择器比留空更危险。
    loginSurfaceSelectors: [],
  },

  chat: {
    // 实测：唯一可编辑元素是 `textarea#chat-textarea`，类名 `ci-textarea ci-scroll-style`。
    //
    // ⚠️ **placeholder 绝不能当选择器**：它是**轮换的热点话题**，实测同一天内出现过
    // 「肖战第1次上热搜涨粉130万」「帮我写国旗下讲话发言稿」「智界 RX及鸿蒙智行新品发布会」
    // 「帮我写面试自我介绍模版」—— 每次刷新都可能不同。
    composerSelectors: ["textarea#chat-textarea"],
    // 实测页面上**提取不到任何发送控件**（探测脚本的 send btns 恒为空数组），
    // 键盘 Enter 是唯一测通的提交路径。仍要填值：sendSelectors 在 profile.js 里是必填项。
    // 指向输入框是准确的 —— 焦点在输入框时按 Enter 就是实测通过的提交路径，
    // driver 不应把它当成「点这个按钮」。
    sendSelectors: ["textarea#chat-textarea"],
    // ⚠️ `ai-markdown` 这一位是**必需的排他位**，不能简化成 `.ai-entry-block`。
    //
    // 实测同一轮里 `ai-entry-block.ai-thinking-steps`（搜索步骤 + 关键词 + 参考条目）
    // 834-942 字符，而 `ai-entry-block.ai-markdown`（真正的答案）62-235 字符。
    // 两者是兄弟节点、共用 ai-entry-block 类名，按"最长文本块"取答案会稳定地采到思考过程，
    // 而它在报告里看起来和正常答案没有区别。
    answerSelectors: [".ai-entry-block.ai-markdown", "[class*='ai-markdown']"],
    // ⚠️ 这里**故意留空**，而这不是"还没量到"。
    //
    // 实测 14 轮：停止/暂停控件（stop/pause/停止/中断）**恒为 0 次出现**，正文里也从不出现
    // 「生成中 / 正在生成 / 停止生成 / 思考中」。文心根本不用文案表示"还在生成"。
    //
    // 那用什么判完成？**追问气泡**（`cs-question-closely-*`）：实测它只在平台认为这一轮
    // 结束时渲染，与答案冻结同帧（探针 15：29.1 秒内恒为 0，t=29.6s 出现，之后恒定）。
    // 这是本平台唯一可靠的完成信号，driver 直接查 DOM，不经过这里。
    //
    // ⚠️ 曾经误判成"没有完成信号、只能靠长度稳定"，于是收下过 41 字符的
    // **重写中间态**（平台的收尾追问句）当成答案，而 status=success。
    // 真因是文心的答案块**不是流式增长、而是反复整块重写**：
    // 长度序列实测 116 → 40 → 9 → 115 → 134 → 36 → 19 → 41。
    // 教训：找不到「生成中」文案不等于平台没有完成信号 —— 先把页面上出现的东西
    // 按时间轴对齐一遍，答案自己会告诉你它在哪一刻收尾。
    inProgressPatterns: [],
    // 实测：对话内的提问气泡类名 `cs-question-bubble`（外层 `conversation-flow-question-container`），
    // 且提问**原文**在页面里出现 16 处。头 10 处全在历史栏
    // （`chat-side-list-item` / `history-item-content` / `history-item-text`）——
    // 历史栏跨会话累积，锚到它会读到上一轮的提问。
    userBubbleSelectors: [".cs-question-bubble", "[class*='conversation-flow-question-container']"],
    // 实测 14 轮 URL 始终停在 wenxin.baidu.com 根路径，会话状态只在页面内（不进路径），
    // 所以没有可回查的 conversationId。不写 pattern（不猜）。
    conversationUrlPattern: null,
    // 未验证「发送控件在生成期间是否消失」—— 因为压根找不到发送控件。不声明。
    busyWhenSendMissing: undefined,
  },

  citation: {
    // 2026-09-28 实测：文心**会**自陈来源数，两种文案数字一致：
    //   「搜索3个关键词 共参考22篇资料」与「搜索全网22篇资料」都出现过。
    // 所以口径是 SELF_REPORTED_COUNT，能与解析到的条目数对账，数量不等时下游标 partial。
    //
    // 注意这与智谱的差别：智谱第一次实测也判成 DOM_ONLY，换一道带检索的题才发现
    // 平台会自陈「N个来源」。「没观测到」和「不存在」是两回事 —— 前者不能当后者用。
    tier: CITATION_TIERS.SELF_REPORTED_COUNT,
    countPattern: /(?:共参考|搜索全网)\s*(\d+)\s*篇资料/,
    // 参考资料列表：实测 `ol[class*='reference']` > `li[class*='reference-item']`，
    // 22-45 条。**条目里没有任何 <a>**，链接在 `data-long-press-ext-info` 的 JSON 里，
    // 所以 blockSelectors 指向条目本身而不是链接。
    blockSelectors: ["li[class*='reference-item']"],
    wrapperRedirectHosts: [],
  },

  networkEvidence: {
    // 实测观察到 `chat.baidu.com/aichat/api/...` 与 `mbd.baidu.com/ztbox` 端点，
    // 但**未捕获**其响应体做结构化解析，不声明 —— 没解析过就不能当证据用。
    requestUrlPatterns: [],
    conversationIdPatterns: [],
  },

  quota: {
    // 2026-09-28 实测撞到百度安全验证墙：页面**导航**到
    // `wappass.baidu.com/static/captcha/tuxing_v2.html`，正文为
    // 「百度安全验证 / 请完成下方验证后继续操作 / 拖动左侧滑块使图片为正 / 扫码验证」。
    // 那里的 DOM 里**没有 textarea**，所以任何按输入框存在性的判断都会误报成
    // 「弹层没关掉」或「页面结构变化」。登记在这里是**必需**的 ——
    // MULTI_PLATFORM_LESSONS.md §4：撞墙认不出来就只能记成 TIMEOUT，
    // 报告和告警读不出真相，而真相需要「等平台放行」这个完全不同的处置。
    exhaustedPatterns: [/百度安全验证/, /请完成下方验证/, /拖动左侧滑块/],
    // 1，与豆包/千问/智谱同口径。实测两问之间必须点「新对话」清空上下文，否则第二个问题
    // 落在同一段对话里 —— 那测的是「追问后的可见性」，引用率与提及率被人为抬高。
    promptsPerWindow: 1,
    // 未观测到「问了但没回」的情形，保持与千问同一起步值。
    suspectedIdleMs: 120_000,
    // 已实测有效：这一句能拿到简短稳定的自述回答（实测 62-235 字符），
    // 便于识别「额度用尽」与「风控拦截」—— 两者需要相反的处置。
    controlPrompt: "你好，请用一句话介绍你自己。",
  },

  limits: {
    // 2026-09-28 实测：5 个独立浏览器会话各问 1 题全部成功（间隔 30 秒），
    // 同一会话连问 4 题也全部成功（间隔 20 秒）—— **本轮探测期间没再撞墙**。
    // 撞墙记录来自探测 13（连续 5 轮探针、约 15 题之后），所以分界线是**累积提问量**，
    // 不是单题频率 —— 与千问「当天累计约 37 次后弹登录墙」同形
    // （docs/MULTI_PLATFORM_LESSONS.md §4）。
    //
    // ⚠️ **这些值当前不会被消费。** accounts/safety.js 只读全局的
    // ONEGL_MIN_DELAY_MS / ONEGL_MAX_DELAY_MS / ONEGL_ACCOUNT_HOURLY_LIMIT /
    // ONEGL_ACCOUNT_DAILY_LIMIT；代码里不存在对 profile.limits 的引用
    // （doubao-web.js 也没有这个字段，zhipu-web.js 的同名字段同样没人读 —— 已记 §10.4）。
    // 保留它是为了记录实测结论，**不是**当前生效的配置。
    // 当前生效的是全局值，部署环境已按 60-120 秒 / 小时 6 / 日 20 配置。
    minDelayMs: 60_000,
    maxDelayMs: 120_000,
    hourlyLimit: 6,
    dailyLimit: 20,
  },
};

/**
 * 文心一言的采集适配器，接到 src/wenxin.js 的真实 driver。
 *
 * 注册闸门就是 profile 的 `validated` 标志：翻成 false 会让整个 adapter 从
 * providers/index.js 的表里消失（症状是 `Unsupported provider adapter: "wenxin"`，
 * 而不是一条清晰的校验错误），公开枚举也由那张表推导，所以「API 接受这个平台」
 * 与「采集器真能跑它」不会脱节。
 */
export const wenxinWebProvider = {
  id: "wenxin-web",
  provider: "wenxin",
  model: "wenxin",
  access: PROVIDER_ACCESS.SCRAPED,
  profile: wenxinWebProfile,
  requiresStoredAuth: false,

  openPage(page, config) {
    return openWenxin(page, config, wenxinWebProfile);
  },

  async run({ page, prompt, config }) {
    const raw = await executeWenxinPrompt(page, prompt, config, wenxinWebProfile);
    return normalizeProviderResult(
      {
        ...raw,
        textContent: raw.answer,
        rawOutput: raw,
        webQueries: [],
      },
      {
        provider: wenxinWebProfile.provider,
        model: wenxinWebProfile.model,
        access: wenxinWebProfile.access,
      },
    );
  },
};
