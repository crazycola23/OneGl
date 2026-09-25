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

/**
 * 豆包匿名面的设定。
 *
 * **不声明任何爆量额度（burst）**：豆包匿名面现在只有一条限制 —— 每 2 条提问切换一次
 * 指纹（`ONEGL_WINDOW_RESET_EVERY=2`，且 `ONEGL_WINDOW_RESET_PROVIDERS` 已含 doubao）。
 * 切了身份之后平台不再拦截，所以没有「每 N 条要静置 M 分钟」这种规则可配。
 *
 * 我一度在这里配过 `burstPrompts: 5` + `burstPauseMs: 25min`，依据是一轮连续测量
 * （前 5 条成功、第 6 条起失败）。**那个结论是错的，错在测量方法**：测量脚本直接连续调
 * `executeDoubaoPrompt`，绕过了 worker 的 `prepareWindow` —— 也就是在一个**从不切换指纹**
 * 的会话里连续提问。测出来的自然是「不换身份时会被拦」，而不是平台的额度边界。
 *
 * 教训：测额度必须在**真实采集路径**上测（含指纹轮换），否则测到的是测量环境的假象。
 *
 * `promptsPerWindow: 1` 留着，因为它不是额度限制而是样本质量要求：一个窗口里的第二个问题
 * 会落在同一段对话上下文里，那测的就不再是「独立提问下的可见性」而是「追问后的可见性」，
 * 引用与品牌提及率会被人为抬高。千问同理。
 */
const doubaoWebProfile = {
  // 注册闸门：`providers/index.js` 只放行 `validated === true` 的 profile，
  // 没有这一位的 profile 会让**整个 adapter 从表里消失**（症状是
  // `Unsupported provider adapter: "doubao"`，而不是一条清晰的校验错误）。
  validated: true,
  quota: {
    promptsPerWindow: 1,
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
