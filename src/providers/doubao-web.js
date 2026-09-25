import { doubaoAnonymousEnabled, executeDoubaoPrompt, openDoubao } from "../doubao.js";
import { normalizeProviderResult, PROVIDER_ACCESS } from "./contract.js";

export function hardenDoubaoCitationFallback(raw) {
  if (!raw || raw.citationSelectorUsed !== "inline-links") return raw;

  // 原实现在这里把 inline-links 回退路径硬判为 parse_failed。
  // 但 inline-links 意味着「来源区块没找到，于是改用回答正文里的内联链接」——
  // 这是抓取策略的降级，不是抓取失败：正文已经拿到，链接也解析出来了。
  // 把它判成失败会让下游整条检测链路在最后一步被否决。
  // 现在保留诊断信息（标明走了内联回退、是否观测到链接），状态沿用上游结论。
  const observed = raw.citations?.length ? "inline-links-observed" : "inline-links-empty";
  return {
    ...raw,
    citationDiagnostics: [
      ...new Set([
        ...(Array.isArray(raw.citationDiagnostics) ? raw.citationDiagnostics : []),
        "reference-block-not-found",
        observed,
      ]),
    ],
  };
}

const DOUBAO_BURST_PAUSE_MS_DEFAULT = 25 * 60_000;

/**
 * 平台那轮额度用尽后要静置多久，0 = 不静置（取消这条限制）。
 *
 * 与千问同形：每次判定时现读环境变量，所以改完重启进程即生效，也避免把「默认 25 分钟」
 * 这个数字埋成看不出源头的常量。
 *
 * **内联读环境变量而不是复用 `accounts/safety.js` 的 `intEnvValue`**：那条导入会形成
 * `providers/doubao-web.js → accounts/safety.js → providers/index.js → providers/doubao-web.js`
 * 的环，实测直接报 `Cannot access 'doubaoWebProvider' before initialization`。
 * 千问走同样的导入之所以没事，只是因为它恰好先被求值 —— 依赖加载顺序是脆弱的，
 * 这里不值得赌。
 *
 * 这个默认值目前是**暂借千问的**：豆包静置多久恢复尚未实测（见下方 profile 注释）。
 */
function doubaoBurstPauseMs() {
  const raw = process.env.ONEGL_DOUBAO_BURST_PAUSE_MS;
  if (raw == null || raw === "") return DOUBAO_BURST_PAUSE_MS_DEFAULT;
  const parsed = Number(raw);
  // 非整数（含空串、NaN）退回默认值；负数原样返回，由 providerBurstPacing 判成「无额度」
  // —— 与千问一致：真正的把关在 profile 校验，这里不吞掉非法值。
  return Number.isInteger(parsed) ? parsed : DOUBAO_BURST_PAUSE_MS_DEFAULT;
}

/**
 * 豆包匿名面的节奏设定。
 *
 * 与千问对齐的是**机制**，不是数字 —— 两边的额度形态实测下来不一样，照抄数字只会配错：
 *
 * - `promptsPerWindow: 1`：同千问，每问换窗口。一个窗口里的第二个问题会落在同一段对话
 *   上下文里，那测的就不是「独立提问下的可见性」而是「追问一句之后的可见性」，
 *   引用与品牌提及率会被人为抬高。
 * - `burstPrompts: 5`：**实测值**。2026-09-25 连续测量（measure-doubao-quota.mjs）：
 *   修掉推广弹窗之后前 5 条连续成功，第 6 条起连续 `DOUBAO_SUBMISSION_FAILED`。
 *   千问是 4，豆包是 5，不要互相套用。
 * - `burstPauseMs`：用 getter 读 `ONEGL_DOUBAO_BURST_PAUSE_MS`，形状与千问完全一致
 *   （0 = 关闭静置）。**默认值暂借千问的 25 分钟，尚未实测** —— 豆包静置多久恢复没有测过。
 *   这一条要写明，否则以后会有人把它当成实测值来推理。
 *
 * 为什么需要这一段：`providerBurstPacing()` 读的是 `provider.profile.quota`，
 * 豆包此前**根本没有 `profile` 字段**，所以拿到的永远是 null —— 额度节奏对它完全不生效。
 */
const doubaoWebProfile = {
  // 注册闸门：`providers/index.js` 只放行 `validated === true` 的 profile，
  // 没有这一位的 profile 会让**整个 adapter 从表里消失**（症状是
  // `Unsupported provider adapter: "doubao"`，而不是一条清晰的校验错误）。
  validated: true,
  quota: {
    promptsPerWindow: 1,
    burstPrompts: 5,
    get burstPauseMs() {
      return doubaoBurstPauseMs();
    },
  },
};

export const doubaoWebProvider = {
  id: "doubao-web",
  provider: "doubao",
  model: "doubao",
  access: PROVIDER_ACCESS.SCRAPED,
  profile: doubaoWebProfile,
  // Declared explicitly so every caller reasons about one shape instead of about whether a
  // missing field means "account" or "nobody thought about it".
  //
  // 用 getter 而不是字面量：匿名面是**运行时可切**的（ONEGL_DOUBAO_ANONYMOUS），而这一位
  // 决定了五处逻辑的分支 —— worker 要不要写登录态、runner 记 account 还是 anonymous、
  // task-routes 要不要强制绑定账号、cli 的 auth 子命令、以及额度豁免与并发槽位。
  // 写成字面量就只能改代码重发版本来切，而它本来就是个开关。
  //
  // 打开后豆包与千问那条匿名通道同形：不吃账号额度、可并发开多个浏览器、不需要登录态。
  // 平台是否允许匿名提问必须先实测确认，见 src/doubao.js 的 doubaoAnonymousEnabled 注释。
  get requiresStoredAuth() {
    return !doubaoAnonymousEnabled();
  },
  frontEndGuard: true,

  openPage(page, config) {
    return openDoubao(page, config);
  },

  async run({ page, prompt, config }) {
    const raw = hardenDoubaoCitationFallback(
      await executeDoubaoPrompt(page, prompt, config),
    );
    return normalizeProviderResult(
      {
        ...raw,
        textContent: raw.answer,
        rawOutput: raw,
        webQueries: [],
      },
      {
        provider: this.provider,
        model: this.model,
        access: this.access,
      },
    );
  },
};
