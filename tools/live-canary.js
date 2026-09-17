import "dotenv/config";

import { launchBrowserSession } from "../src/browser.js";
import { runOnePrompt } from "../src/collect/runner.js";
import { loadConfig } from "../src/config.js";
import { openDoubao } from "../src/doubao.js";
import { RunStore } from "../src/store.js";

function fail(message, details = null) {
  const error = new Error(message);
  if (details) error.details = details;
  throw error;
}

function canaryPrompt() {
  const configured = String(process.env.ONEGL_CANARY_PROMPT ?? "").trim();
  if (configured) return configured;
  return "请用两三句话介绍杭州西湖；如果当前回答界面提供资料来源，请正常保留来源。";
}

function assertCanaryResult(outcome) {
  if (!outcome?.ok) {
    fail("provider run did not complete successfully", {
      errorCode: outcome?.saved?.errorCode ?? outcome?.normalized?.code ?? null,
      errorMessage: outcome?.saved?.errorMessage ?? outcome?.normalized?.message ?? null,
    });
  }

  const run = outcome.saved;
  if (!run || run.status !== "success") {
    fail("live canary requires a citation-complete success run", {
      status: run?.status ?? null,
      citationState: run?.citationState ?? null,
      citationDiagnostics: run?.citationDiagnostics ?? [],
    });
  }
  if (run.conversationResetConfirmed !== true) {
    fail("fresh-conversation gate was not confirmed", {
      conversationResetConfirmed: run.conversationResetConfirmed ?? null,
    });
  }
  if (!String(run.answer ?? "").trim()) fail("answer capture was empty");
  if (!["found", "none_visible"].includes(run.citationState)) {
    fail("citation extractor did not reach an authoritative state", {
      citationState: run.citationState ?? null,
      citationDiagnostics: run.citationDiagnostics ?? [],
    });
  }
  if ((run.citationDiagnostics ?? []).some((item) => String(item).includes("inline-link"))) {
    fail("citation extractor fell back to inline-link diagnostics", {
      citationDiagnostics: run.citationDiagnostics,
    });
  }
  return run;
}

async function main() {
  const accountKey = String(process.env.ONEGL_ACCOUNT ?? "canary").trim() || "canary";
  const config = loadConfig({ accountKey, headless: true });
  const store = new RunStore(config);
  const session = await launchBrowserSession(config);
  try {
    await openDoubao(session.page, config);
    const outcome = await runOnePrompt({
      page: session.page,
      store,
      config,
      prompt: canaryPrompt(),
      project: "live-canary",
      context: { accountKey },
      pool: null,
    });
    const run = assertCanaryResult(outcome);
    console.log(JSON.stringify({
      ok: true,
      run_id: run.id,
      answer_chars: String(run.answer ?? "").length,
      citation_state: run.citationState,
      citation_count: Array.isArray(run.citations) ? run.citations.length : 0,
      conversation_reset_confirmed: run.conversationResetConfirmed,
      network_evidence_state: run.networkEvidenceState ?? "disabled",
    }));
  } finally {
    await session.close();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    details: error?.details ?? null,
  }));
  process.exitCode = 1;
});
