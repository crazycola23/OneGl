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

export const doubaoWebProvider = {
  id: "doubao-web",
  provider: "doubao",
  model: "doubao",
  access: PROVIDER_ACCESS.SCRAPED,
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
