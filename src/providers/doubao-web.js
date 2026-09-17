import { executeDoubaoPrompt } from "../doubao.js";
import { normalizeProviderResult, PROVIDER_ACCESS } from "./contract.js";

export const doubaoWebProvider = {
  id: "doubao-web",
  provider: "doubao",
  model: "doubao",
  access: PROVIDER_ACCESS.SCRAPED,

  async run({ page, prompt, config }) {
    const raw = await executeDoubaoPrompt(page, prompt, config);

    // Inline answer links are useful diagnostic evidence, but they are not proof that
    // the reference block was parsed completely. If the source-block selector drifted,
    // treating the observed inline links as both expected and captured would make the
    // collector report a false success. Preserve the links while failing citation
    // completeness closed.
    if (raw.citationSelectorUsed === "inline-links") {
      raw.citationState = "parse_failed";
      raw.expectedCitationCount = null;
      raw.citationDiagnostics = [
        ...new Set([
          ...(Array.isArray(raw.citationDiagnostics) ? raw.citationDiagnostics : []),
          "reference-block-not-found",
          ...(raw.citations?.length ? ["inline-links-observed"] : []),
        ]),
      ];
    }

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
