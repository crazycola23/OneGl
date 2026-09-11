import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import { RunStore } from "./store.js";

function parseArgs(tokens) {
  const args = { _: [] };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = tokens[index + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeUrl(value) {
  return String(value || "").trim();
}

function percent(passed, total) {
  if (!total) return null;
  return Number(((passed / total) * 100).toFixed(2));
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function scaffold(args) {
  const config = loadConfig();
  const store = new RunStore(config);
  const project = typeof args.project === "string" ? args.project : null;
  const suiteId =
    typeof args.suite === "string" ? args.suite : "phase0-doubao-browser-spike-v1";
  const output = path.resolve(
    typeof args.out === "string"
      ? args.out
      : path.join(config.dataDir, "phase0-review.json"),
  );

  let runs = (await store.listRuns()).filter((run) => run.validation?.caseId);
  if (project) runs = runs.filter((run) => run.project === project);
  runs.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));

  const reviewRuns = [];
  for (const run of runs) {
    // Artifacts live under attempts/<n>/ once a run has been retried, so the recorded
    // artifact directory is the source of truth rather than the run root.
    const artifactBase = run.artifactPath ?? run.debugPath;
    const artifactDir = run.artifactPath ? path.resolve(run.artifactPath) : store.runDir(run.id);
    const domObservation = await readJsonIfPresent(
      path.join(artifactDir, "dom-observation.json"),
    );
    const forbiddenLeakTokens = run.validation?.forbiddenLeakTokens || [];
    const leakedTokens = forbiddenLeakTokens.filter((token) =>
      String(run.answer || "").includes(token),
    );

    reviewRuns.push({
      runId: run.id,
      caseId: run.validation?.caseId || null,
      targetScenario: run.validation?.targetScenario || null,
      tags: run.validation?.tags || [],
      reviewFocus: run.validation?.reviewFocus || null,
      prompt: run.prompt,
      artifacts: {
        run: path.join(run.debugPath, "run.json"),
        screenshot: path.join(artifactBase, "screenshot.png"),
        pageHtml: path.join(artifactBase, "page.html"),
        answer: path.join(artifactBase, "answer.md"),
        citations: path.join(artifactBase, "citations.json"),
        domObservation: path.join(artifactBase, "dom-observation.json"),
      },
      captured: {
        status: run.status,
        errorCode: run.errorCode,
        answerChars: String(run.answer || "").length,
        citationState: run.citationState,
        expectedCitationCount: run.expectedCitationCount,
        citationDiagnostics: run.citationDiagnostics || [],
        citations: (run.citations || []).map((citation) => ({
          position: citation.sourcePosition,
          title: citation.title,
          url: citation.url,
          canonicalUrl: citation.canonicalUrl,
          marker: citation.citationMarker,
          answerText: citation.answerText,
          relationStatus: citation.relationStatus,
        })),
        conversation: {
          reset: run.conversationReset,
          resetMethod: run.conversationResetMethod || null,
          beforeUrl: run.conversationBeforeUrl || null,
          afterResetUrl: run.conversationAfterResetUrl || null,
          finalUrl: run.currentUrl || null,
          conversationId: run.conversationId || null,
          forbiddenLeakTokens,
          leakedTokens,
          promptEchoCount: domObservation?.conversation?.promptEchoCount ?? null,
          distinctVisibleUserMessageCount:
            domObservation?.conversation?.distinctVisibleUserMessageCount ?? null,
        },
        domSummary: domObservation
          ? {
              selectorStats: domObservation.selectorStats,
              visibleAnswerNodeCount:
                domObservation.answer?.visibleNodeCount ?? null,
              visibleSourceBlockCount:
                domObservation.sources?.visibleBlockCount ?? null,
              sourceSignals: (domObservation.sources?.blocks || []).map(
                (block) => block.citationSignal,
              ),
              visibleOverlayCount:
                domObservation.overlays?.visibleCount ?? null,
              inlineExternalLinkCount:
                domObservation.answer?.inlineExternalLinks?.length ?? 0,
              sessionSignals: domObservation.sessionSignals || null,
            }
          : null,
      },
      ui: {
        answerMatches: null,
        visibleCitationCount: null,
        citations: [],
        conversationIsolated: null,
        observedScenario: [],
        failureClass: null,
        notes: "",
      },
    });
  }

  const payload = {
    schemaVersion: 1,
    suiteId,
    generatedAt: new Date().toISOString(),
    rules: {
      answerMatches:
        "Set true only after comparing answer.md with the complete visible Doubao answer. Do not ignore missing/extra paragraphs.",
      visibleCitationCount:
        "Count only UI-visible sources after expanding the reference UI when necessary. Never use network/SSE results as visible citations.",
      citations:
        "Enter UI source rows in exact visible order. Copy title and the visible source link target exactly. relationMatches is boolean only when the answer-to-source relation is observable; otherwise leave null.",
      conversationIsolated:
        "Set true only if this run is visibly in a clean/new conversation and no previous prompt/answer remains in the active turn context.",
      missingReviewData:
        "Missing ground-truth fields are excluded from metric denominators and are never counted as pass.",
    },
    runs: reviewRuns,
  };

  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Review scaffold written: ${output}`);
  console.log(`Runs included: ${reviewRuns.length}`);
}

function evaluateRun(entry) {
  const failures = [];
  const captured = entry.captured || {};
  const ui = entry.ui || {};
  const capturedCitations = Array.isArray(captured.citations)
    ? captured.citations
    : [];
  const uiCitations = Array.isArray(ui.citations) ? ui.citations : [];

  let answerReviewed = false;
  let answerPass = false;
  if (typeof ui.answerMatches === "boolean") {
    answerReviewed = true;
    answerPass = ui.answerMatches;
  }
  if (answerReviewed && !answerPass) failures.push("ANSWER_MISMATCH");

  const countReviewed = Number.isInteger(ui.visibleCitationCount);
  const countPass =
    countReviewed && capturedCitations.length === ui.visibleCitationCount;
  if (countReviewed && !countPass) failures.push("CITATION_COUNT_MISMATCH");

  let titleReviewed = 0;
  let titlePass = 0;
  let urlReviewed = 0;
  let urlPass = 0;
  let relationReviewed = 0;
  let relationPass = 0;
  let positionReviewed = 0;
  let positionPass = 0;

  for (let index = 0; index < uiCitations.length; index += 1) {
    const ground = uiCitations[index] || {};
    const actual = capturedCitations[index] || {};
    if (typeof ground.title === "string" && ground.title.trim()) {
      titleReviewed += 1;
      if (normalizeText(actual.title) === normalizeText(ground.title)) titlePass += 1;
    }
    if (typeof ground.url === "string" && ground.url.trim()) {
      urlReviewed += 1;
      if (normalizeUrl(actual.url) === normalizeUrl(ground.url)) urlPass += 1;
      positionReviewed += 1;
      if (
        actual &&
        normalizeUrl(actual.url) === normalizeUrl(ground.url) &&
        Number(actual.position) === index + 1
      ) {
        positionPass += 1;
      }
    }
    if (typeof ground.relationMatches === "boolean") {
      relationReviewed += 1;
      if (ground.relationMatches) relationPass += 1;
    }
  }

  if (titleReviewed && titlePass !== titleReviewed) {
    failures.push("CITATION_TITLE_MISMATCH");
  }
  if (urlReviewed && urlPass !== urlReviewed) {
    failures.push("CITATION_URL_MISMATCH");
  }
  if (positionReviewed && positionPass !== positionReviewed) {
    failures.push("CITATION_ORDER_MISMATCH");
  }
  if (relationReviewed && relationPass !== relationReviewed) {
    failures.push("CITATION_RELATION_MISMATCH");
  }

  const orderReviewed =
    uiCitations.length > 0 &&
    uiCitations.every(
      (citation) => typeof citation?.url === "string" && citation.url.trim(),
    );
  const orderPass =
    orderReviewed &&
    capturedCitations.length === uiCitations.length &&
    uiCitations.every(
      (citation, index) =>
        normalizeUrl(capturedCitations[index]?.url) === normalizeUrl(citation.url) &&
        Number(capturedCitations[index]?.position) === index + 1,
    );

  const isolationReviewed = typeof ui.conversationIsolated === "boolean";
  const isolationPass = isolationReviewed && ui.conversationIsolated;
  if (isolationReviewed && !isolationPass) {
    failures.push("CONVERSATION_ISOLATION_FAILED");
  }

  for (const token of captured.conversation?.leakedTokens || []) {
    failures.push(`AUTO_LEAK_TOKEN:${token}`);
  }
  if (captured.errorCode) failures.push(`RUN_ERROR:${captured.errorCode}`);
  for (const diagnostic of captured.citationDiagnostics || []) {
    failures.push(`CAPTURE_DIAGNOSTIC:${diagnostic}`);
  }
  if (typeof ui.failureClass === "string" && ui.failureClass.trim()) {
    failures.push(`MANUAL:${ui.failureClass.trim()}`);
  }

  return {
    runId: entry.runId,
    caseId: entry.caseId,
    answerReviewed,
    answerPass,
    countReviewed,
    countPass,
    titleReviewed,
    titlePass,
    urlReviewed,
    urlPass,
    relationReviewed,
    relationPass,
    positionReviewed,
    positionPass,
    orderReviewed,
    orderPass,
    isolationReviewed,
    isolationPass,
    failures: [...new Set(failures)],
  };
}

function addMetric(total, key, reviewed, passed) {
  total[key].reviewed += reviewed;
  total[key].passed += passed;
}

function markdownReport(report) {
  const rows = Object.entries(report.metrics)
    .map(([name, metric]) => {
      const value = metric.accuracy == null ? "N/A" : `${metric.accuracy}%`;
      return `| ${name} | ${value} | ${metric.passed}/${metric.reviewed} |`;
    })
    .join("\n");
  const failures = report.failureCases.length
    ? report.failureCases
        .map(
          (item) =>
            `- ${item.caseId || item.runId} (${item.runId}): ${item.failures.join(", ")}`,
        )
        .join("\n")
    : "- None among reviewed samples.";
  return `# Phase 0 Doubao Validation Report\n\nGenerated: ${report.generatedAt}\n\n| Metric | Accuracy | Passed / Reviewed |\n|---|---:|---:|\n${rows}\n\n## Failure cases\n\n${failures}\n\n## Interpretation rules\n\n- Missing manual ground truth is never counted as pass.\n- Visible Citation metrics use only the real Doubao UI. Network/SSE data is not accepted as Visible Citation ground truth.\n- A UI-declared reference count mismatch remains a failure; the evaluator never rewrites the expected count.\n`;
}

async function evaluate(args) {
  if (typeof args.file !== "string") {
    throw new Error("--file is required");
  }
  const input = path.resolve(args.file);
  const payload = JSON.parse(await readFile(input, "utf8"));
  if (!Array.isArray(payload.runs)) throw new Error("Review file has no runs array");

  const totals = {
    answerCaptureAccuracy: { reviewed: 0, passed: 0 },
    visibleCitationCountAccuracy: { reviewed: 0, passed: 0 },
    citationTitleAccuracy: { reviewed: 0, passed: 0 },
    citationUrlAccuracy: { reviewed: 0, passed: 0 },
    citationOrderAccuracy: { reviewed: 0, passed: 0 },
    citationPositionAccuracy: { reviewed: 0, passed: 0 },
    answerCitationRelationAccuracy: { reviewed: 0, passed: 0 },
    conversationIsolationSuccessRate: { reviewed: 0, passed: 0 },
  };

  const evaluations = payload.runs.map(evaluateRun);
  for (const item of evaluations) {
    addMetric(
      totals,
      "answerCaptureAccuracy",
      item.answerReviewed ? 1 : 0,
      item.answerPass ? 1 : 0,
    );
    addMetric(
      totals,
      "visibleCitationCountAccuracy",
      item.countReviewed ? 1 : 0,
      item.countPass ? 1 : 0,
    );
    addMetric(totals, "citationTitleAccuracy", item.titleReviewed, item.titlePass);
    addMetric(totals, "citationUrlAccuracy", item.urlReviewed, item.urlPass);
    addMetric(
      totals,
      "citationOrderAccuracy",
      item.orderReviewed ? 1 : 0,
      item.orderPass ? 1 : 0,
    );
    addMetric(
      totals,
      "citationPositionAccuracy",
      item.positionReviewed,
      item.positionPass,
    );
    addMetric(
      totals,
      "answerCitationRelationAccuracy",
      item.relationReviewed,
      item.relationPass,
    );
    addMetric(
      totals,
      "conversationIsolationSuccessRate",
      item.isolationReviewed ? 1 : 0,
      item.isolationPass ? 1 : 0,
    );
  }

  const metrics = Object.fromEntries(
    Object.entries(totals).map(([key, value]) => [
      key,
      { ...value, accuracy: percent(value.passed, value.reviewed) },
    ]),
  );
  const failureCases = evaluations
    .filter((item) => item.failures.length)
    .map(({ runId, caseId, failures }) => ({ runId, caseId, failures }));
  const failureClassCounts = {};
  for (const item of failureCases) {
    for (const failure of item.failures) {
      failureClassCounts[failure] = (failureClassCounts[failure] || 0) + 1;
    }
  }

  const report = {
    schemaVersion: 1,
    suiteId: payload.suiteId || null,
    generatedAt: new Date().toISOString(),
    reviewedRunCount: payload.runs.length,
    metrics,
    failureClassCounts,
    failureCases,
  };

  const output = path.resolve(
    typeof args.out === "string"
      ? args.out
      : path.join(path.dirname(input), "phase0-report.json"),
  );
  const markdownOutput = output.endsWith(".json")
    ? output.slice(0, -5) + ".md"
    : `${output}.md`;
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownOutput, markdownReport(report), "utf8");

  console.table(
    Object.entries(metrics).map(([metric, value]) => ({
      metric,
      accuracy: value.accuracy == null ? "N/A" : `${value.accuracy}%`,
      reviewed: value.reviewed,
      passed: value.passed,
    })),
  );
  console.log(`JSON report: ${output}`);
  console.log(`Markdown report: ${markdownOutput}`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (command === "scaffold") await scaffold(args);
  else if (command === "evaluate") await evaluate(args);
  else {
    console.log(`Phase 0 validation tools\n\nCommands:\n  node src/validate.js scaffold [--project phase0-validation] [--out .onegl/phase0-review.json]\n  node src/validate.js evaluate --file .onegl/phase0-review.json [--out .onegl/phase0-report.json]`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
