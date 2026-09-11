import { BRAND_DETECTION_VERSION, compileBrandRules, detectBrandMention } from "../brand/detect.js";
import { persistRun } from "../db/persist.js";
import { captureDomObservation } from "../dom-observer.js";
import { executeDoubaoPrompt } from "../doubao.js";
import { ErrorCode, normalizeError } from "../errors.js";

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
  // 队列重试时传入真实 attempt；命令行单次运行没有这个概念，固定为 1。
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

  // 本次尝试的产物目录（相对仓库根），与函数入参 artifactPath（调用方指定）区分开。
  const attemptArtifactPath = store.attemptPath(run.id, attempt);
  let saved = null;
  let normalized = null;
  let ok = false;

  try {
    const result = await executeDoubaoPrompt(page, prompt, config);
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
      attempt,
      artifactPath: attemptArtifactPath,
      ...applyBrandDetection(context.brandRules ?? null, result.answer),
      errorCode: partial ? ErrorCode.CITATION_PARSE_FAILED : null,
      errorMessage: partial
        ? "回答已抓到，但可见引用数量与页面标注不一致。"
        : null,
    });
  } catch (error) {
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
      attempt,
      artifactPath: attemptArtifactPath,
      // 这条失败恰恰说明没有独立新会话，明确记 false，而不是留空让统计去猜。
      conversationResetConfirmed:
        normalized.code === ErrorCode.CONVERSATION_RESET_FAILED
          ? false
          : (run.conversationResetConfirmed ?? null),
    });
  }

  // 数据库写入独立于采集结果：采集成功但入库失败时，本地调试产物仍然保留。
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
