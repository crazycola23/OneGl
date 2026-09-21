/**
 * OpenAPI applier for the typed report contract, report revisions and the batch question
 * identity fields. Runs after `applySaasOpenApi` (so it can extend the SaaS resources
 * additively) and before `applyContractHardeningOpenApi` (which attaches operationIds, tags
 * and the common 401/403/503/400/404 responses).
 */

const nullableDateTime = { type: ["string", "null"], format: "date-time" };
const nullableString = { type: ["string", "null"] };
const count = { type: "integer", minimum: 0 };
const nullableCount = { type: ["integer", "null"], minimum: 0 };
const ratio = { type: ["number", "null"], minimum: 0, maximum: 1 };

const taskId = { type: "string", pattern: "^tsk_[a-f0-9]{32}$" };
const executionId = { type: "string", pattern: "^exe_[a-f0-9]{32}$" };
const reportId = { type: "string", pattern: "^rpt_[a-f0-9]{32}$" };
const revisionId = { type: "string", pattern: "^rrev_[a-f0-9]{32}$" };
const contentHash = { type: "string", pattern: "^[a-f0-9]{64}$" };

function object(properties, { required = [], additionalProperties = false } = {}) {
  return {
    type: "object",
    ...(required.length ? { required } : {}),
    properties,
    additionalProperties,
  };
}

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const responseRef = (name) => ({ $ref: `#/components/responses/${name}` });
const envelope = (schema) => object({ data: schema }, { required: ["data"] });
const arrayEnvelope = (schema) => object({ data: { type: "array", items: schema }, meta: ref("PageMeta") }, { required: ["data", "meta"] });

const truncation = object({
  truncated: { type: "boolean", description: "True when the underlying query hit its own cap, so the list below is a Top-N and not a census." },
  limit: { type: ["integer", "null"], minimum: 1 },
  returned: { type: "integer", minimum: 0 },
}, { required: ["truncated", "returned"] });

const qualityMetric = object({
  label: nullableString,
  kind: { type: "string", enum: ["rate", "count"] },
  numerator: count,
  denominator: count,
  measured: { type: "boolean", description: "False when the denominator is 0. `value: null` plus `measured: false` means 'not measurable', which is different from 0." },
  value: { type: ["number", "null"], minimum: 0 },
}, { required: ["kind", "numerator", "denominator", "measured", "value"] });

const sourcePage = object({
  fetch_state: nullableString,
  content_excerpt: nullableString,
  content_profile: { type: ["object", "null"], additionalProperties: true, description: "Provider page-content profile as captured; keys are informational and not part of the stable contract." },
  outline: { type: "array", items: object({ level: { type: ["integer", "number"] }, text: nullableString }, { additionalProperties: true }) },
  paragraph_count: { type: ["integer", "null"] },
  text_length: { type: ["integer", "null"] },
  h1_count: { type: ["integer", "null"] },
  h2_count: { type: ["integer", "null"] },
  h3_count: { type: ["integer", "null"] },
  table_count: { type: ["integer", "null"] },
  list_count: { type: ["integer", "null"] },
  faq_heading_count: { type: ["integer", "null"] },
  author_present: { type: ["boolean", "null"] },
  published_at_raw: nullableString,
  modified_at_raw: nullableString,
  brand_mentioned: { type: ["boolean", "null"] },
  brand_mention_count: { type: ["integer", "null"] },
  brand_first_mention_position: { type: ["integer", "null"] },
  brand_matched_terms: { type: "array", items: { type: "string" } },
  brand_contexts: { type: "array", items: { type: "object", additionalProperties: true } },
  brand_locations: { type: "array", items: { type: "string" } },
  brand_detection_version: nullableString,
});

const reportContractSchemas = {
  TaskQuestionEntry: object({
    text: { type: "string", minLength: 1, description: "Question asked to the provider." },
    external_id: {
      type: ["string", "null"],
      pattern: "^[A-Za-z0-9._:-]{1,200}$",
      description: "Caller-owned stable id for this single observation. When present, identical texts are kept apart.",
    },
    repetition_index: { type: ["integer", "null"], minimum: 1 },
    repetition_count: { type: ["integer", "null"], minimum: 1 },
    category: { type: ["string", "null"], maxLength: 200 },
  }, {
    required: ["text"],
    additionalProperties: false,
  }),

  TerminalReason: object({
    code: {
      type: "string",
      description: "Stable reason code. Sourced from the collector run error when one exists, otherwise from the batch terminal cause.",
      examples: ["collection_failed", "execution_cancelled", "assignment_skipped", "account_access_restricted"],
    },
    message: nullableString,
  }, { required: ["code", "message"] }),

  ReportVersions: object({
    schema: { type: "string", const: "report-contract-v1" },
    intelligence: { type: ["integer", "null"], description: "Version of the cited-page intelligence producer, or null when analysis has not produced a payload yet." },
    summary: { type: "integer" },
    renderer: { type: "string" },
  }, { required: ["schema", "summary", "renderer"] }),

  ReportProvenance: object({
    provider: { type: "string", const: "doubao_web" },
    contract_version: { type: "string", const: "report-contract-v1" },
    generated_at: { type: "string", format: "date-time" },
    source: { type: "string", const: "onegl" },
  }, { required: ["provider", "contract_version", "generated_at", "source"] }),

  ReportCollection: object({
    status: { type: "string", enum: ["pending", "queued", "running", "paused", "completed", "partial", "failed", "cancelled"] },
    started_at: nullableDateTime,
    finished_at: nullableDateTime,
    progress: object({
      total: count,
      completed: count,
      failed: count,
      skipped: count,
      not_collected: { type: "integer", minimum: 0, description: "Assignments that will never produce a collection record: skipped work plus failed runs on a terminal execution." },
    }, { required: ["total", "completed", "failed", "skipped", "not_collected"] }),
  }, { required: ["status", "progress"] }),

  ReportAnalysis: object({
    status: { type: "string", enum: ["idle", "queued", "running", "completed", "partial", "failed"], description: "Cited-page content analysis stage. Independent from collection: `collection` can be terminal while this is still `queued`." },
    generation: { type: "integer", minimum: 0 },
    queued_at: nullableDateTime,
    started_at: nullableDateTime,
    finished_at: nullableDateTime,
    error: nullableString,
    stale: { type: "boolean" },
  }, { required: ["status", "generation", "stale"] }),

  ReportReadiness: object({
    status: {
      type: "string",
      enum: ["empty", "collecting", "collecting_complete", "analysis_running", "complete", "complete_with_gaps", "failed", "cancelled"],
      description: "Derived from collection *and* analysis. `complete` is only reachable once cited-page analysis has finished for the current collection.",
    },
    explainable: { type: "boolean", const: true },
    notes: { type: "array", items: { type: "string" } },
  }, { required: ["status", "explainable", "notes"] }),

  ReportContractSummary: object({
    batch: object({
      name: nullableString,
      provider: nullableString,
      status: nullableString,
      sampling_method: nullableString,
      repeats: { type: ["integer", "null"], minimum: 1 },
      requested_jobs: nullableCount,
      completed_jobs: nullableCount,
      failed_jobs: nullableCount,
      skipped_jobs: nullableCount,
      project_name: nullableString,
      target_brand: nullableString,
      queued_at: nullableDateTime,
      started_at: nullableDateTime,
      finished_at: nullableDateTime,
      aborted_at: nullableDateTime,
      created_at: nullableDateTime,
    }),
    runs: object({
      assignmentsRun: count,
      valid: count,
      partial: count,
      failed: count,
      unconfirmedReset: count,
      mentioned: count,
      mentionRate: { type: ["number", "null"], minimum: 0, maximum: 1 },
    }, { required: ["assignmentsRun", "valid", "partial", "failed", "mentioned"] }),
    prompts: object({
      total: count,
      mentioned: count,
      mentionCoverage: ratio,
    }, { required: ["total", "mentioned"] }),
    citations: object({
      validRuns: count,
      coverage: { type: ["number", "null"], minimum: 0 },
      total: count,
      articles: count,
      domains: count,
    }, { required: ["total", "articles", "domains"] }),
    tracked: object({
      total: count,
      cited: count,
      citationRate: ratio,
      articles: {
        type: "array",
        items: object({
          canonical_url: nullableString,
          title: nullableString,
          domain: nullableString,
          citations: count,
          runs: count,
          prompts: count,
          account_count: count,
          first_seen_at: nullableDateTime,
          last_seen_at: nullableDateTime,
        }, { required: ["citations", "runs", "prompts"] }),
      },
    }, { required: ["total", "cited", "articles"] }),
    citationFactors: { type: ["object", "null"], additionalProperties: true, description: "Candidate-to-citation factor analysis. Internal identifiers are removed; the remaining statistical keys are documented in docs/CITATION_FACTOR_ANALYSIS.md." },
    topArticles: {
      type: "array",
      items: object({
        canonical_url: nullableString,
        title: nullableString,
        domain: nullableString,
        citations: count,
        runs: count,
      }, { required: ["citations", "runs"] }),
    },
    topDomains: {
      type: "array",
      items: object({
        domain: nullableString,
        citations: count,
        articles: count,
        runs: count,
      }, { required: ["citations", "articles", "runs"] }),
    },
    byCategory: {
      type: "array",
      items: object({
        category: nullableString,
        valid_runs: count,
        mentioned: count,
        mention_rate: ratio,
      }, { required: ["valid_runs", "mentioned"] }),
    },
    byAccount: {
      type: "array",
      description: "Per-collector-slot numbers. OneGl's internal account keys are never exposed; `slot` is an opaque label stable within one report.",
      items: object({
        slot: { type: "string", pattern: "^account-[0-9]+$" },
        valid_runs: count,
        mentioned: count,
        mention_rate: ratio,
        prompts: count,
        citations: count,
      }, { required: ["slot", "valid_runs", "mentioned", "prompts", "citations"] }),
    },
    failures: {
      type: "array",
      items: object({ error_code: nullableString, runs: count }, { required: ["runs"] }),
    },
    sourceDomains: {
      type: "array",
      items: object({
        domain: nullableString,
        citations: count,
        articles: nullableCount,
        runs: nullableCount,
        prompts: nullableCount,
      }),
    },
    sourceArticles: {
      type: "array",
      items: object({
        canonical_url: nullableString,
        title: nullableString,
        domain: nullableString,
        citations: count,
        runs: nullableCount,
        prompts: nullableCount,
        is_tracked: { type: ["boolean", "null"] },
      }),
    },
    sourceTotals: object({ citations: count, articles: count, domains: count }, { required: ["citations", "articles", "domains"] }),
    intelligence: object({
      version: { type: ["integer", "null"] },
      coverage: {
        type: ["object", "null"],
        properties: {
          answerValidRuns: count,
          citationValidRuns: count,
          citationEvidenceRate: ratio,
          citedSources: count,
          analyzedSources: count,
          analysisRate: ratio,
          brandEvidenceSources: count,
          brandEvidenceRate: ratio,
        },
        additionalProperties: false,
      },
      attributionNote: nullableString,
      domains: {
        type: "array",
        items: object({
          domain: nullableString,
          citations: count,
          sources: count,
          prompt_count: count,
          brand_evidence_sources: count,
        }, { required: ["citations", "sources", "prompt_count", "brand_evidence_sources"] }),
      },
      brandEvidenceSources: { type: "array", items: ref("ReportContractSource") },
    }),
  }, { required: ["batch", "runs", "prompts", "citations", "tracked", "topArticles", "topDomains", "byCategory", "byAccount", "failures"] }),

  ReportContractSourcePage: sourcePage,

  ReportContractSource: object({
    canonical_url: nullableString,
    original_url: nullableString,
    final_url: nullableString,
    title: nullableString,
    domain: nullableString,
    citation_count: count,
    run_count: count,
    prompt_count: count,
    average_position: { type: ["number", "null"] },
    prompts: { type: "array", items: { type: "string" } },
    page: { anyOf: [ref("ReportContractSourcePage"), { type: "null" }] },
  }, { required: ["citation_count", "run_count", "prompt_count", "prompts"] }),

  ReportContractQuery: object({
    prompt: nullableString,
    category: nullableString,
    valid_runs: count,
    ai_brand_mentioned_runs: count,
    ai_brand_mention_rate: ratio,
    ai_brand_mention_count: count,
    citation_count: count,
    unique_source_count: count,
    brand_evidence_source_count: count,
    top_sources: {
      type: "array",
      items: object({ url: nullableString, title: nullableString, domain: nullableString, citations: count }, { required: ["citations"] }),
    },
    example_answer: nullableString,
    example_answer_contains_brand: { type: "boolean" },
  }, { required: ["valid_runs", "ai_brand_mentioned_runs", "citation_count", "top_sources"] }),

  ReportContractStructure: {
    type: ["object", "null"],
    properties: {
      citedSources: count,
      analyzedSources: count,
      coverageRate: ratio,
      profileTypes: { type: "array", items: object({ label: { type: "string" }, count: count }, { required: ["label", "count"] }) },
      commonStructures: { type: "array", items: object({ label: { type: "string" }, count: count }, { required: ["label", "count"] }) },
      withH2Rate: ratio,
      withTableRate: ratio,
      withListRate: ratio,
      withFaqRate: ratio,
      withAuthorRate: ratio,
      withPublishedDateRate: ratio,
      averageTextLength: { type: ["integer", "null"] },
      averageH2Count: { type: ["number", "null"] },
    },
    additionalProperties: false,
  },

  ReportContractRun: object({
    result_id: { type: ["string", "null"], pattern: "^res_[a-f0-9]{32}$" },
    question: nullableString,
    question_external_id: nullableString,
    repetition_index: nullableCount,
    repetition_count: nullableCount,
    category: nullableString,
    status: { type: ["string", "null"], enum: ["pending", "running", "success", "partial", "failed", null] },
    started_at: nullableDateTime,
    finished_at: nullableDateTime,
    brand_mentioned: { type: ["boolean", "null"] },
    mention_count: nullableCount,
    expected_citation_count: nullableCount,
    captured_citation_count: nullableCount,
    citation_state: nullableString,
    conversation_reset: { type: ["boolean", "null"] },
    conversation_reset_confirmed: { type: ["boolean", "null"] },
    error_code: nullableString,
    attempt: { type: ["integer", "null"], minimum: 1 },
    answer_chars: { type: ["integer", "null"], minimum: 0 },
  }, { required: ["question", "status"] }),

  ReportContractResource: object({
    report_id: reportId,
    task_id: taskId,
    execution_id: executionId,
    revision: { type: "integer", minimum: 0, description: "0 on the live contract endpoint; >= 1 once frozen as a revision." },
    schema_version: { type: "string", const: "report-contract-v1" },
    versions: ref("ReportVersions"),
    provenance: ref("ReportProvenance"),
    collection: ref("ReportCollection"),
    analysis: ref("ReportAnalysis"),
    readiness: ref("ReportReadiness"),
    summary: ref("ReportContractSummary"),
    queries: { type: "array", items: ref("ReportContractQuery") },
    sources: { type: "array", items: ref("ReportContractSource") },
    structure: ref("ReportContractStructure"),
    quality: object({
      run_brand_mention_rate: qualityMetric,
      prompt_brand_coverage: qualityMetric,
      citation_capture_rate: qualityMetric,
      tracked_citation_rate: qualityMetric,
      answer_capture_rate: qualityMetric,
      collection_gap_rate: qualityMetric,
      page_analysis_coverage: qualityMetric,
      brand_evidence_rate: qualityMetric,
      citation_evidence_rate: qualityMetric,
    }, {
      required: [
        "run_brand_mention_rate",
        "prompt_brand_coverage",
        "citation_capture_rate",
        "tracked_citation_rate",
        "answer_capture_rate",
        "collection_gap_rate",
        "page_analysis_coverage",
        "brand_evidence_rate",
        "citation_evidence_rate",
      ],
    }),
    runs: { type: "array", items: ref("ReportContractRun") },
    truncated: object({
      runs: truncation,
      queries: truncation,
      sources: truncation,
      trackedArticles: truncation,
      topArticles: truncation,
      topDomains: truncation,
      sourceDomains: truncation,
      sourceArticles: truncation,
    }),
    totals: object({
      assignments: count,
      valid_runs: count,
      failed_runs: count,
      collected_results: count,
      not_collected_results: count,
      citations: count,
      cited_articles: count,
      cited_domains: count,
      unique_sources: count,
      analyzed_sources: count,
      brand_evidence_sources: count,
      queries: count,
    }, { required: ["assignments", "valid_runs", "citations", "unique_sources"] }),
  }, {
    required: [
      "report_id",
      "task_id",
      "execution_id",
      "revision",
      "schema_version",
      "versions",
      "provenance",
      "collection",
      "analysis",
      "readiness",
      "summary",
      "queries",
      "sources",
      "structure",
      "quality",
      "runs",
      "truncated",
      "totals",
    ],
  }),

  ReportRevisionResource: object({
    revision_id: revisionId,
    report_id: reportId,
    task_id: taskId,
    execution_id: executionId,
    revision: { type: "integer", minimum: 1 },
    schema_version: { type: "string" },
    content_hash: contentHash,
    created_at: { type: "string", format: "date-time" },
    collected_until: nullableDateTime,
    analysis_completed_at: nullableDateTime,
    analysis_generation: { type: ["integer", "null"], minimum: 0 },
    collection_status: nullableString,
    analysis_status: { type: ["string", "null"], enum: ["idle", "queued", "running", "completed", "partial", "failed", null] },
    readiness_status: {
      type: ["string", "null"],
      enum: ["empty", "collecting", "collecting_complete", "analysis_running", "complete", "complete_with_gaps", "failed", "cancelled", null],
    },
    artifact_urls: object({ json: { type: "string" }, html: { type: "string" } }, { required: ["json", "html"] }),
  }, {
    required: ["revision_id", "report_id", "execution_id", "revision", "schema_version", "content_hash", "created_at", "artifact_urls"],
  }),

  ReportRevisionCreated: {
    allOf: [
      ref("ReportRevisionResource"),
      object({
        created: { type: "boolean" },
        replayed: { type: "boolean", description: "True when the computed content hash matched the latest revision, so no new row was written." },
        contract: ref("ReportContractResource"),
      }, { required: ["created", "replayed", "contract"] }),
    ],
  },
};

const ASSIGNMENT_STATUSES = ["not_started", "running", "collected", "not_collected", "cancelled"];

const resultAdditions = {
  question_external_id: nullableString,
  repetition_index: nullableCount,
  repetition_count: nullableCount,
  assignment_status: { type: "string", enum: ASSIGNMENT_STATUSES },
  terminal_reason: { anyOf: [ref("TerminalReason"), { type: "null" }] },
};

/** Response factory mirroring {@link pageJson}: (description, dataSchema). */
function json(description, schema) {
  return {
    description,
    content: { "application/json": { schema: envelope(schema) } },
  };
}

function pageJson(description, itemSchema) {
  return {
    description,
    content: { "application/json": { schema: arrayEnvelope(itemSchema) } },
  };
}

const reportPathId = {
  name: "reportId",
  in: "path",
  required: true,
  schema: { type: "string", pattern: "^rpt_[a-f0-9]{32}$", example: "rpt_0123456789abcdef0123456789abcdef" },
};

const revisionPathId = {
  name: "revision",
  in: "path",
  required: true,
  schema: { type: "integer", minimum: 1 },
  description: "1-based immutable revision number of this report.",
};

const paginationParameters = [
  { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 100 } },
  { name: "cursor", in: "query", description: "Opaque next_cursor returned by the previous page.", schema: { type: "string" } },
];

const idempotencyHeader = {
  name: "Idempotency-Key",
  in: "header",
  required: false,
  description: "Recommended. Reusing the same key with the same request replays the first response; reusing it with a different body returns idempotency_conflict.",
  schema: { type: "string", minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9._:-]+$" },
};

export function applyReportContractOpenApi(document) {
  const schemas = document.components?.schemas;
  if (!schemas) throw new Error("OpenAPI components.schemas must exist before the report contract applier");

  Object.assign(schemas, reportContractSchemas);

  // --- additive fields on the existing SaaS resources -------------------------------
  if (schemas.TaskCreate?.properties?.questions) {
    schemas.TaskCreate.properties.questions = {
      type: "array",
      minItems: 1,
      maxItems: 5000,
      description: "Either plain strings (legacy, de-duplicated by text) or per-observation objects. Entries carrying `external_id` are never de-duplicated by text, so N questions x R repetitions can be submitted as N*R rows. `external_id` requires `sampling.repeats` to stay 1.",
      items: { oneOf: [{ type: "string", minLength: 1 }, ref("TaskQuestionEntry")] },
    };
  }
  if (schemas.TaskResource?.properties) {
    schemas.TaskResource.properties.question_entries = {
      type: "array",
      description: "Echo of the submitted question entries, in caller order.",
      items: object({
        text: { type: "string" },
        question: { type: "string" },
        external_id: nullableString,
        category: nullableString,
        repetition_index: nullableCount,
        repetition_count: nullableCount,
      }, { required: ["text"] }),
    };
  }
  if (schemas.ExecutionProgress) {
    schemas.ExecutionProgress.properties.not_collected = {
      type: "integer",
      minimum: 0,
      description: "Assignments that will never be collected: skipped work plus failed runs once the execution is terminal.",
    };
    schemas.ExecutionProgress.required = [
      ...(schemas.ExecutionProgress.required ?? []),
      "not_collected",
    ];
  }
  if (schemas.ResultListItem) {
    Object.assign(schemas.ResultListItem.properties, resultAdditions, {
      task_id: taskId,
      execution_id: executionId,
    });
    schemas.ResultListItem.required = [
      ...(schemas.ResultListItem.required ?? []),
      "task_id",
      "execution_id",
      "assignment_status",
    ];
  }
  if (schemas.ResultResource) {
    Object.assign(schemas.ResultResource.properties, resultAdditions);
    schemas.ResultResource.properties.task_id = taskId;
    schemas.ResultResource.properties.execution_id = executionId;
    schemas.ResultResource.required = [
      ...(schemas.ResultResource.required ?? []),
      "assignment_status",
    ];
  }
  if (schemas.ReportResource) {
    Object.assign(schemas.ReportResource.properties, {
      contract_url: { type: "string", examples: ["/v1/reports/rpt_0123456789abcdef0123456789abcdef/contract"] },
      versions: ref("ReportVersions"),
      collection: ref("ReportCollection"),
      analysis: ref("ReportAnalysis"),
      readiness: ref("ReportReadiness"),
    });
    schemas.ReportResource.required = [
      ...(schemas.ReportResource.required ?? []),
      "versions",
      "collection",
      "analysis",
      "readiness",
    ];
  }
  if (schemas.SaasWebhookEvent?.properties?.type?.enum && !schemas.SaasWebhookEvent.properties.type.enum.includes("report.revision.ready")) {
    schemas.SaasWebhookEvent.properties.type.enum.push("report.revision.ready");
  }

  const reportPathItem = (operations) => ({ parameters: [reportPathId], ...operations });

  document.components.responses.ReportContractNotFound = {
    description: "Report or revision was not found for this tenant",
    content: { "application/json": { schema: ref("SaasError") } },
  };

  Object.assign(document.paths, {
    "/v1/executions/{executionId}/report/contract": {
      parameters: [{
        name: "executionId",
        in: "path",
        required: true,
        schema: { type: "string", pattern: "^exe_[a-f0-9]{32}$", example: "exe_0123456789abcdef0123456789abcdef" },
      }],
      get: {
        operationId: "getExecutionReportContract",
        summary: "Get the strictly-typed report contract for an execution",
        description: "Separates collection state, cited-page analysis state and report readiness, and carries no internal OneGl identifiers. Equivalent to GET /v1/reports/{reportId}/contract.",
        tags: ["Reports"],
        responses: {
          200: json("Report contract", ref("ReportContractResource")),
          404: responseRef("ReportContractNotFound"),
        },
      },
    },
    "/v1/reports/{reportId}/contract": reportPathItem({
      get: {
        operationId: "getReportContract",
        summary: "Get the strictly-typed report contract",
        description: "Live (recomputed) contract for the report. Collection, cited-page analysis and readiness are reported separately; `truncated` declares every list cap so a Top-15 cannot be read as a full census.",
        tags: ["Reports"],
        responses: {
          200: json("Report contract", ref("ReportContractResource")),
          404: responseRef("ReportContractNotFound"),
        },
      },
    }),
    "/v1/reports/{reportId}/revisions": reportPathItem({
      get: {
        operationId: "listReportRevisions",
        summary: "List frozen report revisions",
        description: "Newest revision first. Revision rows are immutable: `content_hash` is the sha256 of the canonical JSON payload.",
        tags: ["Reports"],
        parameters: paginationParameters,
        responses: {
          200: pageJson("Report revisions", ref("ReportRevisionResource")),
          404: responseRef("ReportContractNotFound"),
        },
      },
      post: {
        operationId: "createReportRevision",
        summary: "Freeze the current report contract as an immutable revision",
        description: "Idempotent by content: when the computed content hash equals the latest revision's hash, the existing revision is returned with `created: false` instead of writing a duplicate snapshot.",
        tags: ["Reports"],
        parameters: [idempotencyHeader],
        responses: {
          201: json("Revision created", ref("ReportRevisionCreated")),
          200: json("Existing revision reused", ref("ReportRevisionCreated")),
          404: responseRef("ReportContractNotFound"),
          409: { $ref: "#/components/responses/SaasConflict" },
        },
      },
    }),
    "/v1/reports/{reportId}/revisions/{revision}": {
      parameters: [reportPathId, revisionPathId],
      get: {
        operationId: "getReportRevision",
        summary: "Get one frozen report revision including its stored contract",
        tags: ["Reports"],
        responses: {
          200: json("Report revision", object({
            ...structuredClone(reportContractSchemas.ReportRevisionResource.properties),
            contract: ref("ReportContractResource"),
          }, {
            required: [...structuredClone(reportContractSchemas.ReportRevisionResource.required), "contract"],
          })),
          404: responseRef("ReportContractNotFound"),
        },
      },
    },
    "/v1/reports/{reportId}/revisions/{revision}/artifact": {
      parameters: [reportPathId, revisionPathId, {
        name: "format",
        in: "query",
        required: false,
        schema: { type: "string", enum: ["json", "html"], default: "json" },
        description: "json serves the stored bytes verbatim; html renders the stored contract through the report renderer.",
      }],
      get: {
        operationId: "getReportRevisionArtifact",
        summary: "Download a frozen revision artifact",
        description: "Serves the stored snapshot as an attachment with `ETag` equal to the revision content hash and `Cache-Control: private, no-cache`. Never recomputed from live tables.",
        tags: ["Reports"],
        responses: {
          200: {
            description: "Frozen revision payload",
            headers: {
              ETag: { description: "Quoted revision content hash.", schema: { type: "string" } },
              "Content-Disposition": { schema: { type: "string", example: "attachment; filename=\"report-rpt_0123456789abcdef0123456789abcdef-r1.json\"" } },
              "Cache-Control": { schema: { type: "string", example: "private, no-cache" } },
              "X-Content-Type-Options": { schema: { type: "string", example: "nosniff" } },
            },
            content: {
              "application/json": { schema: ref("ReportContractResource") },
              "text/html": { schema: { type: "string" } },
            },
          },
          400: { $ref: "#/components/responses/BadRequest" },
          404: responseRef("ReportContractNotFound"),
        },
      },
    },
  });

  return document;
}
