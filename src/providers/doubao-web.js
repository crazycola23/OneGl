import { executeDoubaoPrompt } from "../doubao.js";
import { normalizeProviderResult, PROVIDER_ACCESS } from "./contract.js";

export function hardenDoubaoCitationFallback(raw) {
  if (!raw || raw.citationSelectorUsed !== "inline-links") return raw;

  return {
    ...raw,
    citationState: "parse_failed",
    expectedCitationCount: null,
    citationDiagnostics: [
      ...new Set([
        ...(Array.isArray(raw.citationDiagnostics) ? raw.citationDiagnostics : []),
        "reference-block-not-found",
        ...(raw.citations?.length ? ["inline-links-observed"] : []),
      ]),
    ],
  };
}

export const doubaoWebProvider = {
  id: "doubao-web",
  provider: "doubao",
  model: "doubao",
  access: PROVIDER_ACCESS.SCRAPED,

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
