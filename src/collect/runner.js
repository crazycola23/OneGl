import { BRAND_DETECTION_VERSION, compileBrandRules, detectBrandMention } from "../brand/detect.js";
import { persistRun } from "../db/persist.js";
import { captureDomObservation } from "../dom-observer.js";
import { executeDoubaoPrompt } from "../doubao.js";
import { ErrorCode, normalizeError } from "../errors.js";
import {
  createConservativeDoubaoPage,
  prepareFrontEndForRun,
} from "../front-end-guard.js";
import { createNetworkEvidenceCollector } from "../network-evidence.js";

/**
 * 采集内核的单次执行。
 *
 * 这里是 CLI（npm run run / batch / batch:run）与后台 Worker 共用的唯一入口。
 * Worker 只是换了一种触发方式，登录判断、提问、回答与引用提取、URL 归一化、
 * 品牌检测、PostgreSQL 落库全部复用同一份实现，没有第二套采集逻辑。
 */

export async function captureArtifacts(store, runId, page, prompt = null, attempt = 1) {
  if (!page) return;
  try {
    await store.writeAttemptArtifact(runId, attempt, "page.html", await page.content());
  } catch {
    // Debug capture must never hide the primary run error.
  }
  try {
    await store.writeAttemptArtifact(
      runId,
      attempt,
      "screenshot.png",
      await page.screenshot({ fullPage: true }),
    );
  } catch {
    // Same rule as above.
  }
  try {
    const observation = await captureDomObservation(page, { prompt });
    await store.writeAttemptArtifact(
      runId,
      attempt,
      "dom-observation.json",
      `${JSON.stringify(observation, null, 2)}\n`,
    );
  } catch {
    // Structured DOM evidence is diagnostic only; never mask the primary result.
  }
}

export function applyBrandDetection(rules, answer) {
  if (!rules) {
    return {
      brandMentioned: null,
      mentionCount: null,
      firstMentionPosition: null,
      matchedTerms: [],
      brandDetectionVersion: null,
    };
  }
  const result = detectBrandMention(answer, rules);
  return {
    brandMentioned: result.mentioned,
    mentionCount: result.mentionCount,
    firstMentionPosition: result.firstMentionPosition,
    matchedTerms: result.matchedTerms,
    brandDetectionVersion: BRAND_DETECTION_VERSION,
  };
}

function emptyNetworkEvidence(message) {
  return {
    version: 1,
    state: "partial",
    queries: [],
    retrievedSources: [],
    responses: [],
    diagnostics: [message],
  };
}

async function finalizeNetworkEvidence(collector) {
  try {
    return await collector.stop();
  } catch (error) {
    return emptyNetworkEvidence(
      `collector-stop-failed:${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function writeNetworkEvidenceArtifact(store, runId, attempt, evidence) {
  if (!evidence || evidence.state === "disabled") return;
  try {
    await store.writeAttemptArtifact(
      runId,
      attempt,
      "network-evidence.json",
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
  } catch {
    // Network provenance is supplemental evidence; artifact failure must not hide the run result.
  }
}

function networkEvidencePatch(evidence) {
  if (!evidence) return {};
  return {
    networkEvidenceState: evidence.state,
    searchQueries: Array.isArray(evidence.queries) ? evidence.queries : [],
    retrievedSources: Array.isArray(evidence.retrievedSources)
      ? evidence.retrievedSources
      : [],
    networkEvidenceDiagnostics: Array.isArray(evidence.diagnostics)
      ? evidence.diagnostics
      : [],
  };
}

/**
 * 执行一次提问并落库。
 *
 * 不抛异常：调用方需要根据错误码决定重试、暂停账号还是跳过，
 * 所以把结果与错误一起返回。
 */
export async function runOnePrompt({
  page,
  store,
  config,
  prompt,
  project,
  validation = null,
  context = {},
  runId = null,
  pool = null,
  artifactPath = null,
}) {
  const accountKey = context.accountKey ?? null;
  const samplingBatchId = context.samplingBatchId ?? null;
  const runToken = context.runToken ?? null;
  const jobId = context.jobId ?? null;
  const attempt = Number.isInteger(context.attempt) && context.attempt > 0 ? context.attempt : 1;

  const run = await store.createRun({
    runId,
    prompt,
    project,
    accountKey,
    samplingBatchId,
    runToken,
    jobId,
    attempt,
  });
  if (validation) await store.updateRun(run.id, { validation });

  const attemptArtifactPath = store.attemptPath(run.id, attempt);
  // Turn scope for retrieval evidence.
  //
  // `im/conversation/batch_get` replays the whole conversation, so evidence is only
  // accepted once the page has actually navigated into this run's conversation. Until
  // then the collector is looking at history - which is exactly how a single run ended up
  // reporting 403 candidates accumulated from twenty earlier, unrelated questions.
  const turnScope = { conversationId: null };
  const observeTurnScope = (response) => {
    try {
      if (!/\/im\/conversation\//.test(response.url())) return;
      const body = response.request()?.postData();
      if (!body) return;
      const match = body.match(/"(?:conversation_id|conversationId)"\s*:\s*"?(\d{6,})"?/);
      if (match) turnScope.conversationId = match[1];
    } catch {
      // Scope detection is best-effort; failure must not disturb collection.
    }
  };
  page.on("request", observeTurnScope);

  const networkCollector = createNetworkEvidenceCollector(page, {
    enabled: config.networkEvidenceEnabled === true,
    maxBodyBytes: config.networkEvidenceMaxBodyBytes,
    bodyTimeoutMs: config.networkEvidenceBodyTimeoutMs,
    getTurnId: () => {
      const fromUrl = page.url().match(/\/chat\/(\d{6,})/);
      return turnScope.conversationId ?? fromUrl?.[1] ?? null;
    },
  });
  let networkEvidence = null;
  let frontEndPreflight = null;
  let saved = null;
  let normalized = null;
  let ok = false;

  try {
    // Conservative front-end gate: do not start another turn while the UI is still busy,
    // do not automatically enter the "新工作任务" mode, and fail closed on abnormal UI state.
    frontEndPreflight = await prepareFrontEndForRun(page, config);
    const guardedPage = createConservativeDoubaoPage(page);
    const result = await executeDoubaoPrompt(guardedPage, prompt, config);

    networkEvidence = await finalizeNetworkEvidence(networkCollector);
    page.off("request", observeTurnScope);
    await writeNetworkEvidenceArtifact(store, run.id, attempt, networkEvidence);
    await captureArtifacts(store, run.id, page, prompt, attempt);
    await store.writeAttemptArtifact(run.id, attempt, "answer.md", `${result.answer}\n`);
    await store.writeAttemptArtifact(
      run.id,
      attempt,
      "citations.json",
      `${JSON.stringify(result.citations, null, 2)}\n`,
    );

    const partial = result.citationState === "parse_failed";
    ok = true;
    saved = await store.updateRun(run.id, {
      status: partial ? "partial" : "success",
      completedAt: new Date().toISOString(),
      answer: result.answer,
      citations: result.citations,
      citationState: result.citationState,
      expectedCitationCount: result.expectedCitationCount,
      citationDiagnostics: result.citationDiagnostics,
      submissionMethod: result.submissionMethod,
      conversationReset: result.conversationReset,
      conversationResetConfirmed: result.conversationResetConfirmed ?? null,
      currentUrl: result.currentUrl,
      frontEndPreflight,
      attempt,
      artifactPath: attemptArtifactPath,
      ...networkEvidencePatch(networkEvidence),
      ...applyBrandDetection(context.brandRules ?? null, result.answer),
      errorCode: partial ? ErrorCode.CITATION_PARSE_FAILED : null,
      errorMessage: partial
        ? "回答已抓到，但可见引用数量与页面标注不一致。"
        : null,
    });
  } catch (error) {
    networkEvidence = await finalizeNetworkEvidence(networkCollector);
    page.off("request", observeTurnScope);
    await writeNetworkEvidenceArtifact(store, run.id, attempt, networkEvidence);
    await captureArtifacts(store, run.id, page, prompt, attempt);
    normalized = normalizeError(error);
    const partialAnswer = normalized.details?.partialAnswer || null;
    await store.writeAttemptArtifact(
      run.id,
      attempt,
      "answer.md",
      partialAnswer ? `${partialAnswer}\n` : "",
    );
    await store.writeAttemptArtifact(run.id, attempt, "citations.json", "[]\n");
    if (partialAnswer) {
      await store.writeAttemptArtifact(
        run.id,
        attempt,
        "partial-answer.md",
        `${partialAnswer}\n`,
      );
    }
    saved = await store.updateRun(run.id, {
      status: "failed",
      completedAt: new Date().toISOString(),
      answer: partialAnswer,
      errorCode: normalized.code,
      errorMessage: normalized.message,
      errorDetails: normalized.details,
      currentUrl: page?.url?.() || null,
      frontEndPreflight,
      attempt,
      artifactPath: attemptArtifactPath,
      ...networkEvidencePatch(networkEvidence),
      conversationResetConfirmed:
        normalized.code === ErrorCode.CONVERSATION_RESET_FAILED
          ? false
          : (run.conversationResetConfirmed ?? null),
    });
  }

  let persistSummary = null;
  let persistError = null;
  if (pool) {
    try {
      persistSummary = await persistRun({
        pool,
        run: saved,
        project,
        prompt: validation ? { externalId: validation.caseId ?? null } : null,
        artifactPath: artifactPath ?? attemptArtifactPath,
        accountKey,
        samplingBatchId,
        runToken,
        jobId,
        attempt: saved.attempt ?? attempt,
      });
      saved = await store.updateRun(saved.id, { dbStatus: "success", db: persistSummary });
    } catch (error) {
      persistError = error;
      saved = await store
        .updateRun(saved.id, {
          dbStatus: "failed",
          dbError: { name: error.name, message: error.message },
        })
        .catch(() => saved);
    }
  }

  return { ok, saved, normalized, persistSummary, persistError };
}

export function brandRulesFromConfig(brand) {
  if (!brand?.name) return null;
  return compileBrandRules(brand);
}
