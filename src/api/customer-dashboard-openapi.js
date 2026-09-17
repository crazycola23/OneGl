const envelope = (schema) => ({
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: { data: schema },
});

const ratio = { type: ["number", "null"], minimum: 0, maximum: 1 };
const nullableNumber = { type: ["number", "null"] };
const nullableDateTime = { type: ["string", "null"], format: "date-time" };

export function applyCustomerDashboardOpenApi(document) {
  Object.assign(document.components.schemas, {
    CustomerDashboardResource: {
      type: "object",
      additionalProperties: false,
      required: [
        "task", "period", "latest_execution", "overview", "trends", "competitors",
        "citations", "search_queries", "source_content", "questions", "opportunities", "meta",
      ],
      properties: {
        task: {
          type: "object",
          additionalProperties: false,
          required: ["task_id", "external_id", "name", "target_brand", "platforms", "state"],
          properties: {
            task_id: { type: "string", pattern: "^tsk_[a-f0-9]{32}$" },
            external_id: { type: ["string", "null"] },
            name: { type: "string" },
            target_brand: { type: ["string", "null"] },
            platforms: { type: "array", items: { type: "string", enum: ["doubao"] } },
            state: { type: "string", enum: ["active"] },
          },
        },
        period: {
          type: "object",
          additionalProperties: false,
          required: ["days", "from", "to"],
          properties: {
            days: { type: "integer", minimum: 1, maximum: 365 },
            from: { type: "string", format: "date-time" },
            to: { type: "string", format: "date-time" },
          },
        },
        latest_execution: {
          anyOf: [
            { $ref: "#/components/schemas/ExecutionResource" },
            { type: "null" },
          ],
        },
        overview: {
          type: "object",
          additionalProperties: false,
          required: [
            "valid_runs", "brand_mentions", "visibility_rate", "share_of_voice", "total_entity_mentions",
            "citation_valid_runs", "citation_evidence_coverage_rate", "visible_citations", "cited_domains",
            "citation_stability_score", "citation_landscape",
            "query_fanout_evidence_status", "query_fanout_valid_runs", "query_fanout_evidence_coverage_rate",
            "query_fanout_total", "query_fanout_unique", "source_pages_analyzed",
            "source_analysis_coverage_rate", "source_evidence_quality",
          ],
          properties: {
            valid_runs: { type: "integer", minimum: 0 },
            brand_mentions: { type: "integer", minimum: 0 },
            visibility_rate: ratio,
            share_of_voice: ratio,
            total_entity_mentions: { type: "integer", minimum: 0 },
            citation_valid_runs: { type: "integer", minimum: 0 },
            citation_evidence_coverage_rate: ratio,
            visible_citations: { type: "integer", minimum: 0 },
            cited_domains: { type: "integer", minimum: 0 },
            citation_stability_score: { type: ["number", "null"], minimum: 0, maximum: 100 },
            citation_landscape: { type: "string", enum: ["wide-open", "contested", "locked-in", "insufficient-data"] },
            query_fanout_evidence_status: { type: "string", enum: ["available", "partial", "unavailable"] },
            query_fanout_valid_runs: { type: "integer", minimum: 0 },
            query_fanout_evidence_coverage_rate: ratio,
            query_fanout_total: { type: "integer", minimum: 0 },
            query_fanout_unique: { type: "integer", minimum: 0 },
            source_pages_analyzed: { type: "integer", minimum: 0 },
            source_analysis_coverage_rate: ratio,
            source_evidence_quality: { type: "string", enum: ["strong-observational", "limited-observational", "insufficient-data"] },
          },
        },
        trends: {
          type: "object",
          additionalProperties: false,
          required: ["visibility", "share_of_voice"],
          properties: {
            visibility: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["date", "runs", "brand_mentions", "rate"],
                properties: {
                  date: { type: "string", format: "date" },
                  runs: { type: "integer", minimum: 0 },
                  brand_mentions: { type: "integer", minimum: 0 },
                  rate: ratio,
                },
              },
            },
            share_of_voice: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["date", "brand_mentions", "competitor_mentions", "share"],
                properties: {
                  date: { type: "string", format: "date" },
                  brand_mentions: { type: "integer", minimum: 0 },
                  competitor_mentions: { type: "integer", minimum: 0 },
                  share: ratio,
                },
              },
            },
          },
        },
        competitors: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "mentions", "mention_rate", "share_of_voice"],
            properties: {
              name: { type: "string" },
              mentions: { type: "integer", minimum: 0 },
              mention_rate: ratio,
              share_of_voice: ratio,
            },
          },
        },
        citations: {
          type: "object",
          additionalProperties: false,
          required: ["valid_runs", "evidence_coverage_rate", "total", "unique_domains", "top_domains", "stability"],
          properties: {
            valid_runs: { type: "integer", minimum: 0 },
            evidence_coverage_rate: ratio,
            total: { type: "integer", minimum: 0 },
            unique_domains: { type: "integer", minimum: 0 },
            top_domains: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["domain", "citations", "runs", "share"],
                properties: {
                  domain: { type: "string" },
                  citations: { type: "integer", minimum: 0 },
                  runs: { type: "integer", minimum: 0 },
                  share: ratio,
                },
              },
            },
            stability: {
              type: "object",
              additionalProperties: false,
              required: ["score", "difficulty", "set_volatility", "weighted_volatility", "transitions"],
              properties: {
                score: { type: ["number", "null"], minimum: 0, maximum: 100 },
                difficulty: { type: "string", enum: ["wide-open", "contested", "locked-in", "insufficient-data"] },
                set_volatility: ratio,
                weighted_volatility: ratio,
                transitions: { type: "integer", minimum: 0 },
              },
            },
          },
        },
        search_queries: {
          type: "object",
          additionalProperties: false,
          required: [
            "evidence_status", "valid_runs", "evidence_coverage_rate",
            "total_queries", "unique_queries", "brand_mention_rate", "top_queries", "top_terms",
          ],
          properties: {
            evidence_status: { type: "string", enum: ["available", "partial", "unavailable"] },
            valid_runs: { type: "integer", minimum: 0 },
            evidence_coverage_rate: ratio,
            total_queries: { type: "integer", minimum: 0 },
            unique_queries: { type: "integer", minimum: 0 },
            brand_mention_rate: ratio,
            top_queries: { type: "array", items: { type: "object", additionalProperties: true } },
            top_terms: { type: "array", items: { type: "object", additionalProperties: true } },
          },
        },
        source_content: {
          type: "object",
          additionalProperties: true,
          description: "Observed traits among pages visibly cited by valid Doubao Web runs. Correlational evidence only; not a ranking-factor claim.",
        },
        questions: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "question", "valid_runs", "brand_mentions", "brand_visibility_rate", "strongest_competitor",
              "competitor_mentions", "competitor_mention_rate", "visibility_gap", "latest_result",
            ],
            properties: {
              question: { type: "string" },
              valid_runs: { type: "integer", minimum: 0 },
              brand_mentions: { type: "integer", minimum: 0 },
              brand_visibility_rate: ratio,
              strongest_competitor: { type: ["string", "null"] },
              competitor_mentions: { type: "integer", minimum: 0 },
              competitor_mention_rate: ratio,
              visibility_gap: nullableNumber,
              latest_result: {
                anyOf: [
                  {
                    type: "object",
                    additionalProperties: false,
                    required: ["result_id", "status", "brand_mentioned", "mention_count", "finished_at", "result_url"],
                    properties: {
                      result_id: { type: "string", pattern: "^res_[a-f0-9]{32}$" },
                      status: { type: "string" },
                      brand_mentioned: { type: ["boolean", "null"] },
                      mention_count: { type: ["integer", "null"], minimum: 0 },
                      finished_at: nullableDateTime,
                      result_url: { type: "string" },
                    },
                  },
                  { type: "null" },
                ],
              },
            },
          },
        },
        opportunities: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["source", "category", "priority", "title", "why", "evidence", "guardrail"],
            properties: {
              source: { type: "string", enum: ["geo", "cited_page"] },
              category: { type: "string" },
              priority: nullableNumber,
              title: { type: "string" },
              why: { type: "string" },
              evidence: { type: "object", additionalProperties: true },
              guardrail: { type: ["string", "null"] },
            },
          },
        },
        meta: {
          type: "object",
          additionalProperties: false,
          required: ["questions_total", "questions_returned", "questions_truncated", "question_limit", "rule_mode", "note"],
          properties: {
            questions_total: { type: "integer", minimum: 0 },
            questions_returned: { type: "integer", minimum: 0 },
            questions_truncated: { type: "boolean" },
            question_limit: { type: "integer", minimum: 1, maximum: 500 },
            rule_mode: { type: ["string", "null"] },
            note: { type: "string" },
          },
        },
      },
    },
  });

  document.paths["/v1/tasks/{taskId}/dashboard"] = {
    parameters: [{
      name: "taskId",
      in: "path",
      required: true,
      schema: { type: "string", pattern: "^tsk_[a-f0-9]{32}$" },
    }],
    get: {
      summary: "Get customer-facing GEO dashboard data for a task",
      description: "Front-end-oriented aggregation for Doubao GEO SaaS. Returns overview KPIs, trends, competitors, citation domains, real query fan-out, cited-page observations, priority questions and evidence-grounded opportunities. It intentionally omits internal numeric project/batch/prompt IDs and raw browser/session data.",
      parameters: [
        { name: "days", in: "query", schema: { type: "integer", minimum: 1, maximum: 365, default: 30 } },
        { name: "question_limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 100 } },
      ],
      responses: {
        200: {
          description: "Customer dashboard",
          content: { "application/json": { schema: envelope({ $ref: "#/components/schemas/CustomerDashboardResource" }) } },
        },
        400: { $ref: "#/components/responses/SaasBadRequest" },
        404: { $ref: "#/components/responses/SaasNotFound" },
      },
    },
  };
}
