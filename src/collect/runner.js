import { BRAND_DETECTION_VERSION, compileBrandRules, detectBrandMention } from "../brand/detect.js";
import { persistRun } from "../db/persist.js";
import { captureDomObservation } from "../dom-observer.js";
import { ErrorCode, normalizeError } from "../errors.js";
import {
  createConservativeDoubaoPage,
  prepareFrontEndForRun,
} from "../front-end-guard.js";
import { createNetworkEvidenceCollector } from "../network-evidence.js";
import { getProviderAdapter } from "../providers/index.js";

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

function disabledNetworkEvidence() {
  return {
    version: 1,
    state: "disabled",
    queries: [],
    retrievedSources: [],
    responses: [],
    diagnostics: [],
  };
}

async function finalizeNetworkEvidence(collector) {
  if (!collector) return disabledNetworkEvidence();
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

function mergeSearchQueries(...groups) {
  const seen = new Set();
  const out = [];
  for (const group of groups) {
    for (const value of Array.isArray(group) ? group : []) {
      const query = String(value ?? "").replace(/\s+/g, " ").trim();
      if (!query) continue;
      const key = query.toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(query);
    }
  }
  return out;
}

async function persistSavedRun({
  pool,
  store,
  saved,
  project,
  validation,
  artifactPath,
  accountKey,
  samplingBatchId,
  runToken,
  jobId,
  attempt,
}) {
  const persistSummary = await persistRun({
    pool,
    run: saved,
    project,
    prompt: validation ? { externalId: validation.caseId ?? null } : null,
    artifactPath: artifactPath ?? saved.artifactPath ?? null,
    accountKey,
    samplingBatchId,
    runToken,
    jobId,
    attempt: saved.attempt ?? attempt,
  });
  const next = await store.updateRun(saved.id, {
    dbStatus: "success",
    db: persistSummary,
    dbError: null,
  });
  return { saved: next, persistSummary };
}

function canReplayPersistence(saved, { prompt, project, accountKey, samplingBatchId, runToken }) {
  if (!saved || !["success", "partial"].includes(saved.status)) return false;
  if (saved.dbStatus === "success") return false;
  if (runToken && saved.runToken !== runToken) return false;
  if (saved.prompt !== prompt || saved.project !== project) return false;
  if ((saved.accountKey ?? null) !== (accountKey ?? null)) return false;
  if ((saved.samplingBatchId ?? null) !== (samplingBatchId ?? null)) return false;
  return true;
}

/**
 * 执行一次提问并落库。
 *
 * Browser-backed and direct-API adapters share this entry. DOM/network evidence is
 * enabled only when a browser page exists; provider-reported webQueries/citations are
 * still persisted for non-browser adapters.
 *
 * 不抛异常：调用方需要根据错误码决定重试、暂停账号还是跳过，
 * 所以把结果与错误一起返回。
 */
export async function runOnePrompt({
  page = null,
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
  const provider = getProviderAdapter(context.provider ?? config?.provider ?? "doubao");

  // A completed local observation is immutable provider evidence. If PostgreSQL failed
  // after collection, a BullMQ retry may only replay persistence; it must never submit
  // the same prompt to the provider a second time.
  if (pool && runId) {
    const previous = await store.readRun(runId).catch(() => null);
    if (canReplayPersistence(previous, {
      prompt,
      project,
      accountKey,
      samplingBatchId,
      runToken,
    })) {
      try {
        const replay = await persistSavedRun({
          pool,
          store,
          saved: previous,
          project,
          validation,
          artifactPath,
          accountKey,
          samplingBatchId,
          runToken,
          jobId,
          attempt,
        });
        return {
          ok: true,
          saved: replay.saved,
          normalized: null,
          persistSummary: replay.persistSummary,
          persistError: null,
          persistenceReplay: true,
        };
      } catch (error) {
        const saved = await store.updateRun(previous.id, {
          dbStatus: "failed",
          dbError: { name: error.name, message: error.message },
        }).catch(() => previous);
        return {
          ok: true,
          saved,
          normalized: null,
          persistSummary: null,
          persistError: error,
          persistenceReplay: true,
        };
      }
    }
  }

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
  await store.updateRun(run.id, {
    provider: provider.provider,
    model: provider.model,
    providerAccess: provider.access,
    modelVersion: null,
  });
  if (validation) await store.updateRun(run.id, { validation });

  const attemptArtifactPath = store.attemptPath(run.id, attempt);
  // Turn scope for retrieval evidence. The request callback receives a Playwright Request,
  // not a Response, so postData() is read directly from it.
  const turnScope = { conversationId: null };
  const observeTurnScope = (request) => {
    try {
      if (!/\/im\/conversation\//.test(request.url())) return;
      const body = request.postData?.();
      if (!body) return;
      const match = body.match(/"(?:conversation_id|conversationId)"\s*:\s*"([^"\\]+)"/);
      if (match) turnScope.conversationId = match[1];
    } catch {
      // Scope detection is best-effort; failure must not disturb collection.
    }
  };
  if (page?.on) page.on("request", observeTurnScope);

  const networkCollector = page
    ? createNetworkEvidenceCollector(page, {
      enabled: config.networkEvidenceEnabled === true,
      maxBodyBytes: config.networkEvidenceMaxBodyBytes,
      bodyTimeoutMs: config.networkEvidenceBodyTimeoutMs,
      getTurnId: () => {
        const fromUrl = page.url().match(/\/chat\/([^/?#]+)/);
        return turnScope.conversationId ?? fromUrl?.[1] ?? null;
      },
    })
    : null;
  let networkEvidence = null;
  let frontEndPreflight = null;
  let saved = null;
  let normalized = null;
  let ok = false;

  try {
    let executionPage = page;
    // Doubao keeps its conservative front-end safety boundary. Future API/scraped
    // providers implement their own access mechanics behind the provider adapter.
    if (provider.id === "doubao-web") {
      if (!page) throw new Error("doubao-web provider requires a browser page");
      frontEndPreflight = await prepareFrontEndForRun(page, config);
      executionPage = createConservativeDoubaoPage(page);
    }
    const result = await provider.run({ page: executionPage, prompt, config, context });
    const answer = result.textContent;

    networkEvidence = await finalizeNetworkEvidence(networkCollector);
    page?.off?.("request", observeTurnScope);
    await writeNetworkEvidenceArtifact(store, run.id, attempt, networkEvidence);
    await captureArtifacts(store, run.id, page, prompt, attempt);
    await store.writeAttemptArtifact(run.id, attempt, "answer.md", `${answer}\n`);
    await store.writeAttemptArtifact(
      run.id,
      attempt,
      "citations.json",
      `${JSON.stringify(result.citations, null, 2)}\n`,
    );

    const partial = result.citationState === "parse_failed";
    const networkPatch = networkEvidencePatch(networkEvidence);
    ok = true;
    saved = await store.updateRun(run.id, {
      status: partial ? "partial" : "success",
      completedAt: new Date().toISOString(),
      provider: result.provider ?? provider.provider,
      model: result.model ?? provider.model,
      providerAccess: result.access ?? provider.access,
      modelVersion: result.modelVersion ?? null,
      answer,
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
      ...networkPatch,
      searchQueries: mergeSearchQueries(result.webQueries, networkPatch.searchQueries),
      ...applyBrandDetection(context.brandRules ?? null, answer),
      errorCode: partial ? ErrorCode.CITATION_PARSE_FAILED : null,
      errorMessage: partial
        ? "回答已抓到，但可见引用数量与页面标注不一致。"
        : null,
    });
  } catch (error) {
    networkEvidence = await finalizeNetworkEvidence(networkCollector);
    page?.off?.("request", observeTurnScope);
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
      provider: provider.provider,
      model: provider.model,
      providerAccess: provider.access,
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
      const persisted = await persistSavedRun({
        pool,
        store,
        saved,
        project,
        validation,
        artifactPath: artifactPath ?? attemptArtifactPath,
        accountKey,
        samplingBatchId,
        runToken,
        jobId,
        attempt,
      });
      persistSummary = persisted.persistSummary;
      saved = persisted.saved;
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

  return { ok, saved, normalized, persistSummary, persistError, persistenceReplay: false };
}

export function brandRulesFromConfig(brand) {
  if (!brand?.name) return null;
  return compileBrandRules(brand);
}
