import { executeDoubaoPrompt } from "../doubao.js";
import { normalizeProviderResult, PROVIDER_ACCESS } from "./contract.js";

export const doubaoWebProvider = {
  id: "doubao-web",
  provider: "doubao",
  model: "doubao",
  access: PROVIDER_ACCESS.SCRAPED,

  async run({ page, prompt, config }) {
    const raw = await executeDoubaoPrompt(page, prompt, config);
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
