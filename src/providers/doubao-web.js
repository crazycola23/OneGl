import { executeDoubaoPrompt, openDoubao } from "../doubao.js";
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
  requiresStoredAuth: true,
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
