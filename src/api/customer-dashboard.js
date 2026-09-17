import { loadProjectDoubaoSourceSignals } from "../db/doubao-source-signals.js";
import { loadProjectGeoIntelligence } from "../db/geo-intelligence.js";
import {
  getExecution,
  getTask,
  getTaskInternal,
  listExecutionResults,
} from "../tasks/service.js";

function finite(value) {
  return value == null || !Number.isFinite(Number(value)) ? null : Number(value);
}

async function distinctCitedDomainCount(pool, projectId, from, to) {
  const { rows } = await pool.query(
    `SELECT count(DISTINCT a.normalized_domain)::int AS n
       FROM citations c
       JOIN runs r ON r.id = c.run_id
       JOIN prompts p ON p.id = r.prompt_id
       JOIN articles a ON a.id = c.article_id
      WHERE p.project_id = $1
        AND r.created_at >= $2
        AND r.created_at <= $3
        AND r.status = 'success'
        AND r.conversation_reset_confirmed IS TRUE
        AND r.citation_state IN ('found', 'none_visible')
        AND c.source_type = 'visible'
        AND c.visible_to_user IS TRUE`,
    [projectId, from, to],
  );
  return Number(rows[0]?.n ?? 0);
}

function publicOpportunity(item = {}, source = "geo") {
  const evidence = item.evidence ?? {};
  const mappedEvidence = {};
  for (const [key, value] of Object.entries(evidence)) {
    if (key === "promptId" || key === "projectId" || key === "batchId" || key === "articleId") continue;
    const snake = key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
    if (Array.isArray(value)) {
      mappedEvidence[snake] = value.map((entry) => {
        if (!entry || typeof entry !== "object") return entry;
        return Object.fromEntries(Object.entries(entry).map(([nestedKey, nestedValue]) => [
          nestedKey.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`),
          nestedValue,
        ]));
      });
    } else {
      mappedEvidence[snake] = value;
    }
  }
  return {
    source,
    category: item.category ?? "other",
    priority: finite(item.priority),
    title: item.title ?? "",
    why: item.why ?? "",
    evidence: mappedEvidence,
    guardrail: item.guardrail ?? null,
  };
}

function sourceContentView(source = {}) {
  return {
    cited_pages: Number(source.citedPages ?? 0),
    analyzed_pages: Number(source.analyzedPages ?? 0),
    analysis_coverage_rate: finite(source.analysisCoverageRate),
    brand_evidence_pages: Number(source.brandEvidencePages ?? 0),
    brand_evidence_rate: finite(source.brandEvidenceRate),
    with_h2_rate: finite(source.withH2Rate),
    with_table_rate: finite(source.withTableRate),
    with_list_rate: finite(source.withListRate),
    with_faq_rate: finite(source.withFaqRate),
    with_author_rate: finite(source.withAuthorRate),
    with_published_date_rate: finite(source.withPublishedDateRate),
    average_text_length: finite(source.averageTextLength),
    average_h2_count: finite(source.averageH2Count),
    content_types: (source.contentTypes ?? []).map((row) => ({
      label: row.label,
      count: Number(row.count ?? 0),
    })),
    patterns: (source.patterns ?? []).map((row) => ({
      trait: row.trait,
      observed_rate: finite(row.observedRate),
      sample_pages: Number(row.samplePages ?? 0),
      note: row.note,
    })),
    evidence_quality: source.evidenceQuality ?? "insufficient-data",
    brand_evidence_rule_mode: source.brandEvidenceRuleMode ?? null,
    attribution_note: source.attributionNote ?? null,
  };
}

function queryFanoutView(fanout = {}) {
  return {
    total_queries: Number(fanout.totalQueries ?? 0),
    unique_queries: Number(fanout.uniqueQueries ?? 0),
    brand_mention_rate: finite(fanout.coverageRate),
    top_queries: (fanout.topQueries ?? []).map((row) => ({
      query: row.query,
      count: Number(row.count ?? 0),
      prompts: Number(row.prompts ?? 0),
      brand_mention_rate: finite(row.brandMentionRate),
    })),
    top_terms: (fanout.terms ?? []).slice(0, 30).map((row) => ({
      term: row.term,
      count: Number(row.count ?? 0),
      share: finite(row.share),
    })),
  };
}

function citationView(citations = {}) {
  const stability = citations.stability ?? {};
  return {
    valid_runs: Number(citations.validRuns ?? 0),
    evidence_coverage_rate: finite(citations.coverage),
    total: Number(citations.total ?? 0),
    unique_domains: Number(citations.uniqueDomains ?? citations.topDomains?.length ?? 0),
    top_domains: (citations.topDomains ?? []).map((row) => ({
      domain: row.domain,
      citations: Number(row.citations ?? 0),
      runs: Number(row.runs ?? 0),
      share: finite(row.share),
    })),
    stability: {
      score: finite(stability.stabilityScore),
      difficulty: stability.difficulty ?? "insufficient-data",
      set_volatility: finite(stability.setVolatility),
      weighted_volatility: finite(stability.weightedVolatility),
      transitions: Number(stability.transitions ?? 0),
    },
  };
}

function questionRows(intelligence, latestResults, limit) {
  const latestByQuestion = new Map((latestResults ?? []).map((row) => [row.question, row]));
  return (intelligence.promptGaps ?? []).slice(0, limit).map((row) => {
    const latest = latestByQuestion.get(row.prompt) ?? null;
    return {
      question: row.prompt,
      valid_runs: Number(row.validRuns ?? 0),
      brand_mentions: Number(row.brandMentions ?? 0),
      brand_visibility_rate: finite(row.brandRate),
      strongest_competitor: row.competitor ?? null,
      competitor_mentions: Number(row.competitorMentions ?? 0),
      competitor_mention_rate: finite(row.competitorRate),
      visibility_gap: finite(row.gap),
      latest_result: latest ? {
        result_id: latest.result_id,
        status: latest.status,
        brand_mentioned: latest.brand_mentioned,
        mention_count: latest.mention_count,
        finished_at: latest.finished_at,
        result_url: latest.result_url,
      } : null,
    };
  });
}

export async function buildCustomerDashboard(pool, tenantId, taskId, { days = 30, questionLimit = 100 } = {}) {
  const [task, internal] = await Promise.all([
    getTask(pool, tenantId, taskId),
    getTaskInternal(pool, tenantId, taskId),
  ]);
  if (!task || !internal || task.state === "archived") return null;

  const projectId = Number(internal.project_id);
  const intelligence = await loadProjectGeoIntelligence(pool, projectId, { days });
  if (!intelligence) return null;
  const [sourceContent, uniqueDomains] = await Promise.all([
    loadProjectDoubaoSourceSignals(pool, projectId, {
      from: intelligence.scope.from,
      to: intelligence.scope.to,
    }),
    distinctCitedDomainCount(pool, projectId, intelligence.scope.from, intelligence.scope.to),
  ]);

  let latestExecution = null;
  let latestResults = [];
  if (task.latest_execution_id) {
    latestExecution = await getExecution(pool, tenantId, task.latest_execution_id);
    latestResults = await listExecutionResults(pool, tenantId, task.latest_execution_id) ?? [];
  }

  const source = sourceContentView(sourceContent);
  const citations = citationView(intelligence.citations);
  citations.unique_domains = uniqueDomains;
  const searchQueries = queryFanoutView(intelligence.fanout);
  const competitors = (intelligence.competitors ?? []).map((row) => ({
    name: row.name,
    mentions: Number(row.mentions ?? 0),
    mention_rate: finite(row.mentionRate),
    share_of_voice: finite((intelligence.shareOfVoice?.entries ?? []).find((entry) => !entry.isBrand && entry.name === row.name)?.share),
  }));
  const questions = questionRows(intelligence, latestResults, questionLimit);
  const opportunities = [
    ...(intelligence.opportunities ?? []).map((row) => publicOpportunity(row, "geo")),
    ...(sourceContent.opportunities ?? []).map((row) => publicOpportunity(row, "cited_page")),
  ].sort((a, b) => (b.priority ?? -1) - (a.priority ?? -1) || a.title.localeCompare(b.title, "zh-CN"));

  return {
    task: {
      task_id: task.task_id,
      external_id: task.external_id,
      name: task.name,
      target_brand: task.target_brand,
      platforms: task.platforms,
      state: task.state,
    },
    period: {
      days: Number(intelligence.scope.days ?? days),
      from: intelligence.scope.from,
      to: intelligence.scope.to,
    },
    latest_execution: latestExecution ? {
      ...latestExecution,
      results_url: `/v1/executions/${latestExecution.execution_id}/results`,
      report_url: latestExecution.report_id ? `/v1/reports/${latestExecution.report_id}` : null,
    } : null,
    overview: {
      valid_runs: Number(intelligence.visibility?.validRuns ?? 0),
      brand_mentions: Number(intelligence.visibility?.brandMentions ?? 0),
      visibility_rate: finite(intelligence.visibility?.rate),
      share_of_voice: finite(intelligence.shareOfVoice?.brandShare),
      total_entity_mentions: Number(intelligence.shareOfVoice?.totalMentions ?? 0),
      citation_valid_runs: citations.valid_runs,
      citation_evidence_coverage_rate: citations.evidence_coverage_rate,
      visible_citations: citations.total,
      cited_domains: citations.unique_domains,
      citation_stability_score: citations.stability.score,
      citation_landscape: citations.stability.difficulty,
      query_fanout_total: searchQueries.total_queries,
      query_fanout_unique: searchQueries.unique_queries,
      source_pages_analyzed: source.analyzed_pages,
      source_analysis_coverage_rate: source.analysis_coverage_rate,
      source_evidence_quality: source.evidence_quality,
    },
    trends: {
      visibility: (intelligence.visibility?.series ?? []).map((row) => ({
        date: row.date,
        runs: Number(row.runs ?? 0),
        brand_mentions: Number(row.brandMentions ?? 0),
        rate: finite(row.rate),
      })),
      share_of_voice: (intelligence.shareOfVoice?.series ?? []).map((row) => ({
        date: row.date,
        brand_mentions: Number(row.brandMentions ?? 0),
        competitor_mentions: Number(row.competitorMentions ?? 0),
        share: finite(row.share),
      })),
    },
    competitors,
    citations,
    search_queries: searchQueries,
    source_content: source,
    questions,
    opportunities,
    meta: {
      questions_total: Number(intelligence.promptGaps?.length ?? 0),
      questions_returned: questions.length,
      questions_truncated: Number(intelligence.promptGaps?.length ?? 0) > questions.length,
      question_limit: questionLimit,
      rule_mode: intelligence.ruleMode ?? null,
      note: "Visibility uses answer-valid runs; citation metrics use only citation-complete runs. Cited-page traits are observational correlations, not claims about Doubao ranking or citation causation.",
    },
  };
}
