import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReportContract,
  contractContentHash,
  contractToRenderDetail,
  REPORT_CONTRACT_LIMITS,
  REPORT_CONTRACT_SCHEMA_VERSION,
  reportContractProviders,
} from "../src/reporting/report-contract.js";
import { buildOpenApiDocument } from "../src/api/build-openapi.js";

/** Every key the public contract must never emit, taken from the module's own denylist. */
const FORBIDDEN_KEYS = [
  "account_keys",
  "account_key",
  "account",
  "project_id",
  "project",
  "monitor_execution_id",
  "pool_size",
  "pool_version",
  "sample_size",
  "sampling_seed",
  "batchId",
  "batch_id",
  "sampling_batch_id",
  "id",
  "ids",
  "localRunId",
  "local_run_id",
  "run_id",
  "runId",
  "run_db_id",
  "tracked_article_id",
  "prompt_id",
  "promptId",
  "article_id",
  "articleId",
  "tenant_id",
  "tenantId",
  "storage_state",
  "storageState",
  "cookies",
  "api_key",
  "signing_secret",
];

function collectKeys(value, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, found);
    return found;
  }
  if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      found.push(key);
      collectKeys(inner, found);
    }
  }
  return found;
}

function runRow(index) {
  return {
    id: 9000 + index,
    local_run_id: `run-${index}`,
    account_key: `acct_key_${index % 2}`,
    sampling_batch_id: 42,
    prompt_id: 500 + index,
    prompt: `问题 ${index}`,
    category: "本地推荐",
    status: "success",
    started_at: "2026-09-14T01:00:00Z",
    finished_at: "2026-09-14T01:01:00Z",
    brand_mentioned: true,
    mention_count: 2,
    expected_citation_count: 3,
    captured_citation_count: 3,
    citation_state: "captured",
    conversation_reset: true,
    conversation_reset_confirmed: true,
    error_code: null,
    attempt: 1,
    answer_chars: 512,
  };
}

function baseDetail(overrides = {}) {
  return {
    report: {
      batch: {
        id: 42,
        name: "品牌监测批次",
        // sampling_batches.provider 存的是平台 id（"doubao"），不是出处标签。
        provider: "doubao",
        status: "completed",
        sampling_method: "stratified",
        repeats: 1,
        requested_jobs: 4,
        completed_jobs: 4,
        failed_jobs: 0,
        skipped_jobs: 0,
        project_id: 7,
        project_name: "示例品牌",
        target_brand: "Example",
        monitor_execution_id: 99,
        pool_size: 50,
        pool_version: 2,
        sample_size: 4,
        sampling_seed: "seed-1",
        queued_at: "2026-09-14T00:59:00Z",
        started_at: "2026-09-14T01:00:00Z",
        finished_at: "2026-09-14T02:00:00Z",
        aborted_at: null,
        created_at: "2026-09-14T00:58:00Z",
      },
      runs: {
        assignmentsRun: 4,
        valid: 4,
        partial: 0,
        failed: 0,
        unconfirmedReset: 0,
        mentioned: 2,
        mentionRate: 0.5,
      },
      prompts: { total: 4, mentioned: 2, mentionCoverage: 0.5 },
      citations: { validRuns: 4, coverage: 1, total: 6, articles: 3, domains: 2 },
      tracked: {
        total: 2,
        cited: 1,
        citationRate: 0.5,
        articles: [{
          tracked_article_id: 555,
          canonical_url: "https://example.com/a",
          title: "被跟踪文章",
          domain: "example.com",
          citations: 3,
          runs: 2,
          prompts: 1,
          accounts: 2,
          first_seen_at: "2026-09-01T00:00:00Z",
          last_seen_at: "2026-09-14T00:00:00Z",
        }],
      },
      citationFactors: {
        batchId: 42,
        cohort: { runs: 4, candidates: 10, cited: 6, baselineRate: 0.6 },
        strongestSignals: [{ factor: "page_table_present", candidates: 4, cited: 3, rate: 0.75 }],
      },
      topArticles: [{ tracked_article_id: 1, canonical_url: "https://example.com/a", title: "A", domain: "example.com", citations: 3, runs: 2 }],
      topDomains: [{ domain: "example.com", citations: 3, articles: 1, runs: 2 }],
      byCategory: [{ category: "本地推荐", validRuns: 4, mentioned: 2, mentionRate: 0.5 }],
      byAccount: [
        { account: "acct_key_0", validRuns: 2, mentioned: 1, mentionRate: 0.5, prompts: 2, citations: 3 },
        { account: "acct_key_1", validRuns: 2, mentioned: 1, mentionRate: 0.5, prompts: 2, citations: 3 },
      ],
      failures: [{ error_code: null, runs: 0 }],
    },
    runs: Array.from({ length: 4 }, (_, index) => runRow(index)),
    sources: {
      domains: [{ domain: "example.com", citations: 3, articles: 1, runs: 2, prompts: 1, project_id: 7 }],
      articles: [{ canonical_url: "https://example.com/a", title: "A", domain: "example.com", citations: 3, runs: 2, prompts: 1, is_tracked: true, tracked_article_id: 555 }],
      totals: { citations: 6, articles: 3, domains: 2 },
    },
    intelligence: {
      version: 3,
      attributionNote: "共同观测，不构成因果归因。",
      job: {
        batch_status: "completed",
        status: "completed",
        generation: 2,
        queued_at: "2026-09-14T02:00:01Z",
        started_at: "2026-09-14T02:00:02Z",
        finished_at: "2026-09-14T02:00:09Z",
        error: null,
        stale: false,
      },
      coverage: {
        answerValidRuns: 4,
        citationValidRuns: 4,
        citationEvidenceRate: 1,
        citedSources: 2,
        analyzedSources: 2,
        analysisRate: 1,
        brandEvidenceSources: 1,
        brandEvidenceRate: 0.5,
      },
      queries: [{
        prompt: "问题 0",
        category: "本地推荐",
        validRuns: 2,
        aiBrandMentionedRuns: 1,
        aiBrandMentionRate: 0.5,
        aiBrandMentionCount: 2,
        citationCount: 3,
        uniqueSourceCount: 2,
        brandEvidenceSourceCount: 1,
        topSources: [{ url: "https://example.com/a", title: "A", domain: "example.com", citations: 3 }],
        exampleAnswer: "回答片段",
        exampleAnswerContainsBrand: true,
        prompt_id: 500,
      }],
      sources: [{
        canonicalUrl: "https://example.com/a",
        originalUrl: "https://example.com/a",
        finalUrl: "https://example.com/a",
        title: "A",
        domain: "example.com",
        citationCount: 3,
        runCount: 2,
        promptCount: 1,
        averagePosition: 1.5,
        prompts: ["问题 0"],
        page: {
          fetchState: "success",
          contentExcerpt: "摘要",
          contentProfile: { type: "recommendation_list", structure: ["H1", "H2"] },
          outline: [{ level: 1, text: "标题" }],
          paragraphCount: 8,
          textLength: 1200,
          h1Count: 1,
          h2Count: 2,
          h3Count: 0,
          tableCount: 0,
          listCount: 1,
          faqHeadingCount: 0,
          authorPresent: true,
          publishedAtRaw: "2026-09-01",
          modifiedAtRaw: null,
          brandMentioned: true,
          brandMentionCount: 2,
          brandFirstMentionPosition: 120,
          brandMatchedTerms: ["Example"],
          brandContexts: [{ snippet: "示例品牌" }],
          brandLocations: ["body"],
          brandDetectionVersion: "brand-v1",
        },
      }],
      structure: {
        citedSources: 2,
        analyzedSources: 2,
        coverageRate: 1,
        profileTypes: [{ label: "推荐清单", count: 1 }],
        commonStructures: [{ label: "H1+H2", count: 1 }],
        withH2Rate: 1,
        withTableRate: 0,
        withListRate: 0.5,
        withFaqRate: 0,
        withAuthorRate: 1,
        withPublishedDateRate: 0.5,
        averageTextLength: 1200,
        averageH2Count: 2,
      },
    },
    resultIdentities: [{
      run_id: "run-0",
      result_id: "res_0123456789abcdef0123456789abcdef",
      external_id: "q-0",
      repetition_index: 1,
      repetition_count: 1,
      selection_index: 1,
    }],
    ...overrides,
  };
}

function build(overrides = {}, args = {}) {
  return buildReportContract({
    detail: baseDetail(overrides),
    execution: { status: "completed", started_at: "2026-09-14T01:00:00Z", finished_at: "2026-09-14T02:00:00Z" },
    report: {
      public_id: "rpt_0123456789abcdef0123456789abcdef",
      task_public_id: "tsk_0123456789abcdef0123456789abcdef",
      execution_public_id: "exe_0123456789abcdef0123456789abcdef",
    },
    generatedAt: "2026-09-14T02:00:10.000Z",
    ...args,
  });
}

test("report contract strips every internal identifier, including nested ones", () => {
  const contract = build();
  const keys = new Set(collectKeys(contract));
  for (const forbidden of FORBIDDEN_KEYS) {
    assert.equal(keys.has(forbidden), false, `public contract leaked internal key "${forbidden}"`);
  }

  // batch.id / project_id / monitor_execution_id / pool_* / sampling_seed are also absent from
  // the serialized payload, not merely from the top level.
  const serialized = JSON.stringify(contract);
  assert.equal(serialized.includes("\"batchId\""), false);
  assert.equal(serialized.includes("acct_key_0"), false, "internal account key leaked as a value");

  // byAccount keeps the comparable numbers and replaces the internal key with an opaque slot.
  assert.deepEqual(contract.summary.byAccount.map((row) => row.slot), ["account-1", "account-2"]);
  // tracked.articles.accounts is renamed, citationFactors.batchId is dropped.
  assert.equal(contract.summary.tracked.articles[0].account_count, 2);
  assert.equal(Object.hasOwn(contract.summary.citationFactors, "batchId"), false);
  assert.equal(contract.summary.citationFactors.cohort.cited, 6);
});

test("report contract marks every capped collection truncated with its limit", () => {
  const manyRuns = Array.from({ length: REPORT_CONTRACT_LIMITS.runs }, (_, index) => runRow(index));
  const manyTop = Array.from({ length: REPORT_CONTRACT_LIMITS.topList }, (_, index) => ({
    canonical_url: `https://example.com/${index}`,
    title: `T${index}`,
    domain: "example.com",
    citations: 1,
    runs: 1,
  }));
  const manyDomains = Array.from({ length: REPORT_CONTRACT_LIMITS.sourceAggregates }, (_, index) => ({
    domain: `d${index}.example`,
    citations: 1,
    articles: 1,
    runs: 1,
    prompts: 1,
  }));

  const contract = build({
    report: {
      ...baseDetail().report,
      topArticles: manyTop,
      topDomains: manyTop,
    },
    runs: manyRuns,
    sources: { ...baseDetail().sources, domains: manyDomains, articles: manyDomains },
  });

  assert.deepEqual(contract.truncated.runs, { truncated: true, limit: 500, returned: 500 });
  assert.deepEqual(contract.truncated.topArticles, { truncated: true, limit: 10, returned: 10 });
  assert.deepEqual(contract.truncated.topDomains, { truncated: true, limit: 10, returned: 10 });
  assert.deepEqual(contract.truncated.sourceDomains, { truncated: true, limit: 15, returned: 15 });
  assert.deepEqual(contract.truncated.sourceArticles, { truncated: true, limit: 15, returned: 15 });

  // An uncapped list must not claim to be truncated.
  assert.deepEqual(contract.truncated.queries, { truncated: false, limit: null, returned: 1 });
  assert.deepEqual(contract.truncated.trackedArticles, { truncated: false, limit: null, returned: 1 });

  // Below the cap the flag stays false.
  assert.deepEqual(build().truncated.runs, { truncated: false, limit: 500, returned: 4 });
});

test("collection and analysis are independent: a terminal batch with running analysis is not complete", () => {
  const detail = baseDetail();
  detail.intelligence.job.status = "running";
  detail.intelligence.job.finished_at = null;
  const contract = buildReportContract({
    detail,
    execution: { status: "completed", started_at: null, finished_at: null },
    report: {},
    generatedAt: "2026-09-14T02:00:10.000Z",
  });

  assert.equal(contract.collection.status, "completed", "collection is terminal");
  assert.equal(contract.analysis.status, "running", "analysis is still running");
  assert.notEqual(contract.readiness.status, "complete");
  assert.equal(contract.readiness.status, "analysis_running");

  const queued = baseDetail();
  queued.intelligence.job.status = "queued";
  const queuedContract = buildReportContract({ detail: queued, execution: { status: "completed" }, report: {} });
  assert.equal(queuedContract.analysis.status, "queued");
  assert.equal(queuedContract.readiness.status, "analysis_running");
  assert.notEqual(queuedContract.readiness.status, "complete");
});

test("readiness reaches complete only after analysis finished, and downgrades to gaps otherwise", () => {
  const complete = build();
  assert.equal(complete.collection.status, "completed");
  assert.equal(complete.analysis.status, "completed");
  assert.equal(complete.readiness.status, "complete");

  const running = baseDetail();
  running.intelligence.job.status = "running";
  const runningContract = buildReportContract({ detail: running, execution: { status: "completed" }, report: {} });
  assert.equal(runningContract.readiness.status, "analysis_running");

  // Terminal collection with analysis still idle cannot be "complete" either.
  const idle = baseDetail();
  idle.intelligence.job.status = "idle";
  const idleContract = buildReportContract({ detail: idle, execution: { status: "completed" }, report: {} });
  assert.equal(idleContract.readiness.status, "collecting_complete");

  // Aborted batch maps to the additive "cancelled" vocabulary, in both sections.
  const aborted = baseDetail();
  aborted.report.batch.status = "aborted";
  aborted.report.batch.aborted_at = "2026-09-14T01:30:00Z";
  const abortedContract = buildReportContract({ detail: aborted, execution: { status: "cancelled" }, report: {} });
  assert.equal(abortedContract.collection.status, "cancelled");
  assert.equal(abortedContract.readiness.status, "cancelled");
});

test("every quality metric carries numerator + denominator + measured, and N/A is not 0", () => {
  const contract = build();
  const metricNames = [
    "run_brand_mention_rate",
    "prompt_brand_coverage",
    "citation_capture_rate",
    "tracked_citation_rate",
    "answer_capture_rate",
    "collection_gap_rate",
    "page_analysis_coverage",
    "brand_evidence_rate",
    "citation_evidence_rate",
  ];
  for (const name of metricNames) {
    const metric = contract.quality[name];
    assert.ok(metric, `quality.${name} is missing`);
    for (const field of ["numerator", "denominator", "measured", "value", "kind"]) {
      assert.ok(Object.hasOwn(metric, field), `quality.${name} is missing ${field}`);
    }
    assert.equal(typeof metric.numerator, "number");
    assert.equal(typeof metric.denominator, "number");
    assert.equal(typeof metric.measured, "boolean");
    assert.equal(metric.measured, metric.denominator > 0);
    if (metric.measured) assert.equal(metric.value, metric.numerator / metric.denominator);
    else assert.equal(metric.value, null);
  }

  // A measured rate is a real ratio.
  assert.equal(contract.quality.run_brand_mention_rate.value, 0.5);
  assert.equal(contract.quality.run_brand_mention_rate.measured, true);

  // zero denominator -> unmeasured, and specifically NOT 0.
  const noAnalysis = baseDetail();
  noAnalysis.intelligence.coverage = { ...noAnalysis.intelligence.coverage, analyzedSources: 0, citedSources: 0, brandEvidenceSources: 0 };
  const unmeasured = buildReportContract({ detail: noAnalysis, execution: { status: "completed" }, report: {} });
  assert.equal(unmeasured.quality.page_analysis_coverage.numerator, 0);
  assert.equal(unmeasured.quality.page_analysis_coverage.denominator, 0);
  assert.equal(unmeasured.quality.page_analysis_coverage.measured, false);
  assert.equal(unmeasured.quality.page_analysis_coverage.value, null);
  assert.notEqual(unmeasured.quality.page_analysis_coverage.value, 0, "N/A must not masquerade as 0");

  // An absent section is unmeasured too, not 0%.
  const noTracked = baseDetail();
  delete noTracked.report.tracked;
  const untracked = buildReportContract({ detail: noTracked, execution: { status: "completed" }, report: {} });
  assert.equal(untracked.quality.tracked_citation_rate.denominator, 0);
  assert.equal(untracked.quality.tracked_citation_rate.measured, false);
  assert.equal(untracked.quality.tracked_citation_rate.value, null);
});

test("the results echo the caller's external_id and the contract is JSON-serializable", () => {
  const contract = build();
  assert.equal(contract.schema_version, REPORT_CONTRACT_SCHEMA_VERSION);
  assert.equal(contract.versions.schema, REPORT_CONTRACT_SCHEMA_VERSION);
  assert.equal(contract.runs[0].result_id, "res_0123456789abcdef0123456789abcdef");
  assert.equal(contract.runs[0].question_external_id, "q-0");
  assert.equal(contract.runs[0].repetition_index, 1);
  assert.equal(contract.runs[1].question_external_id, null);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(contract)));
});

test("brand-evidence is counted from the contracted page fields, not silently zero", () => {
  const contract = build();
  // The fixture source has fetchState=success, a non-empty contentProfile and
  // page.brandMentioned=true, so it must be recognised as brand evidence.
  assert.equal(contract.summary.intelligence.brandEvidenceSources.length, 1);
  assert.equal(contract.summary.intelligence.brandEvidenceSources[0].canonical_url, "https://example.com/a");
  assert.equal(contract.summary.intelligence.brandEvidenceSources[0].page.brand_mentioned, true);
  assert.equal(contract.summary.intelligence.domains[0].domain, "example.com");
  assert.equal(contract.summary.intelligence.domains[0].brand_evidence_sources, 1);

  // A page without a content profile is not brand evidence even when the brand is mentioned.
  const unprofiled = baseDetail();
  unprofiled.intelligence.sources[0].page.contentProfile = {};
  const withoutProfile = buildReportContract({ detail: unprofiled, execution: { status: "completed" }, report: {} });
  assert.equal(withoutProfile.summary.intelligence.brandEvidenceSources.length, 0);
  assert.equal(withoutProfile.summary.intelligence.domains[0].brand_evidence_sources, 0);
});

test("a stored contract round-trips back into the renderer's detail shape", () => {
  const detail = contractToRenderDetail(build());
  assert.equal(detail.report.batch.name, "品牌监测批次");
  assert.equal(detail.intelligence.version, 3);
  assert.equal(detail.intelligence.job.status, "completed");
  assert.equal(detail.intelligence.sources[0].canonicalUrl, "https://example.com/a");
  assert.equal(detail.intelligence.sources[0].page.brandMentioned, true);
  assert.equal(detail.intelligence.queries[0].prompt, "问题 0");
  assert.equal(detail.sources.totals.articles, 3);
  // The renderer reads camelCase rows here, so the round trip has to restore that shape.
  assert.equal(detail.intelligence.brandEvidenceSources.length, 1);
  assert.equal(detail.intelligence.brandEvidenceSources[0].citationCount, 3);
  assert.equal(detail.intelligence.brandEvidenceSources[0].page.brandMentionCount, 2);
});

test("the content hash ignores the volatile revision and generated_at fields", () => {
  const base = build();
  const first = { ...base, revision: 1 };
  const second = { ...base, revision: 7, provenance: { ...base.provenance, generated_at: "2030-01-01T00:00:00.000Z" } };
  assert.equal(contractContentHash(first), contractContentHash(second));

  const changed = structuredClone(base);
  changed.analysis.status = "running";
  assert.notEqual(contractContentHash(first), contractContentHash(changed));

  const changedIntelligence = structuredClone(base);
  changedIntelligence.summary.intelligence.brandEvidenceSources = [];
  assert.notEqual(contractContentHash(first), contractContentHash(changedIntelligence));
});

test("report provenance names the platform that actually produced the report", () => {
  const execution = { status: "completed", started_at: null, finished_at: null };
  const doubao = buildReportContract({ detail: baseDetail(), execution, report: {} });
  // 已发布的 v1 取值必须保持不变，否则现有消费者读到的出处会漂移。
  assert.equal(doubao.provenance.provider, "doubao_web");

  const qianwenDetail = baseDetail();
  qianwenDetail.report.batch.provider = "qianwen";
  const qianwen = buildReportContract({ detail: qianwenDetail, execution, report: {} });
  assert.equal(qianwen.provenance.provider, "qianwen_web");
  assert.notEqual(qianwen.provenance.provider, doubao.provenance.provider);
});

test("the OpenAPI provenance enum cannot promise a provenance the producer cannot emit", () => {
  const document = buildOpenApiDocument();
  const provider = document.components.schemas.ReportProvenance.properties.provider;
  assert.deepEqual(provider.enum, reportContractProviders());
  assert.equal(provider.const, undefined, "provenance must not be pinned to one platform");
  assert.ok(provider.enum.includes("qianwen_web"));
});

test("a report declares which observation surfaces contributed to it", () => {
  const execution = { status: "completed", started_at: null, finished_at: null };

  const accountOnly = buildReportContract({ detail: baseDetail(), execution, report: {} });
  assert.deepEqual(accountOnly.provenance.login_states, ["account"],
    "runs predating the surface column are account runs, not unknown ones");
  assert.equal(accountOnly.runs[0].login_state, "account");

  const mixed = baseDetail();
  mixed.runs = [{ ...runRow(9), login_state: "anonymous" }, ...mixed.runs];
  const blended = buildReportContract({ detail: mixed, execution, report: {} });
  assert.deepEqual(
    blended.provenance.login_states.slice().sort(),
    ["account", "anonymous"],
    "blending signed-out and account samples must be visible in provenance, not silently averaged",
  );
});
