const VALID_RUN_SQL = "r.status IN ('success', 'partial') AND r.conversation_reset_confirmed IS TRUE";

function num(value) {
  return Number(value ?? 0);
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function rate(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function increment(map, key, amount = 1) {
  const label = String(key ?? "unknown") || "unknown";
  map.set(label, (map.get(label) ?? 0) + amount);
}

function sortedCounts(map) {
  return [...map.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "zh-CN"));
}

function pageHasAnalysis(page) {
  return Boolean(
    page?.fetchState === "success" &&
      page?.contentProfile &&
      typeof page.contentProfile === "object" &&
      Object.keys(page.contentProfile).length > 0,
  );
}

function pageHasCurrentBrandEvidence(page) {
  return pageHasAnalysis(page) && page?.brandMentioned === true;
}

function structureSummary(sources) {
  const observed = sources.filter((row) => pageHasAnalysis(row.page));
  const profileTypes = new Map();
  const structures = new Map();
  let withH2 = 0;
  let withTable = 0;
  let withList = 0;
  let withFaq = 0;
  let withAuthor = 0;
  let withPublishedDate = 0;
  let textLengthTotal = 0;
  let h2Total = 0;

  for (const source of observed) {
    const page = source.page ?? {};
    increment(profileTypes, page.contentProfile?.type ?? "unclassified");
    const signature = array(page.contentProfile?.structure).join(" + ") || "无明确结构标签";
    increment(structures, signature);
    if (num(page.h2Count) > 0) withH2 += 1;
    if (num(page.tableCount) > 0) withTable += 1;
    if (num(page.listCount) > 0) withList += 1;
    if (num(page.faqHeadingCount) > 0) withFaq += 1;
    if (page.authorPresent === true) withAuthor += 1;
    if (page.publishedAtRaw) withPublishedDate += 1;
    textLengthTotal += num(page.textLength);
    h2Total += num(page.h2Count);
  }

  const total = observed.length;
  return {
    citedSources: sources.length,
    analyzedSources: total,
    coverageRate: rate(total, sources.length),
    profileTypes: sortedCounts(profileTypes),
    commonStructures: sortedCounts(structures),
    withH2Rate: rate(withH2, total),
    withTableRate: rate(withTable, total),
    withListRate: rate(withList, total),
    withFaqRate: rate(withFaq, total),
    withAuthorRate: rate(withAuthor, total),
    withPublishedDateRate: rate(withPublishedDate, total),
    averageTextLength: total ? Math.round(textLengthTotal / total) : null,
    averageH2Count: total ? h2Total / total : null,
  };
}

function sourceKey(citation) {
  return citation.canonicalUrl || citation.finalUrl || citation.originalUrl || `${citation.domain}:${citation.title}`;
}

function buildSourceRows(runs) {
  const map = new Map();
  for (const run of runs) {
    for (const citation of run.citations) {
      const key = sourceKey(citation);
      const row = map.get(key) ?? {
        key,
        canonicalUrl: citation.canonicalUrl,
        originalUrl: citation.originalUrl,
        finalUrl: citation.finalUrl,
        title: citation.title,
        domain: citation.domain,
        citationCount: 0,
        runs: new Set(),
        prompts: new Set(),
        positions: [],
        page: citation.page,
      };
      row.citationCount += 1;
      row.runs.add(run.localRunId || run.id);
      row.prompts.add(run.prompt);
      if (citation.sourcePosition != null) row.positions.push(Number(citation.sourcePosition));
      if (!pageHasAnalysis(row.page) && pageHasAnalysis(citation.page)) row.page = citation.page;
      map.set(key, row);
    }
  }

  return [...map.values()]
    .map((row) => ({
      ...row,
      runCount: row.runs.size,
      promptCount: row.prompts.size,
      prompts: [...row.prompts],
      averagePosition: row.positions.length
        ? row.positions.reduce((sum, value) => sum + value, 0) / row.positions.length
        : null,
      runs: undefined,
      positions: undefined,
    }))
    .sort((a, b) => b.citationCount - a.citationCount || b.promptCount - a.promptCount || String(a.canonicalUrl ?? "").localeCompare(String(b.canonicalUrl ?? "")));
}

function buildDomainRows(sources) {
  const map = new Map();
  for (const source of sources) {
    const domain = source.domain || "(unknown)";
    const row = map.get(domain) ?? { domain, citations: 0, sources: 0, prompts: new Set(), brandEvidenceSources: 0 };
    row.citations += source.citationCount;
    row.sources += 1;
    for (const prompt of source.prompts) row.prompts.add(prompt);
    if (pageHasCurrentBrandEvidence(source.page)) row.brandEvidenceSources += 1;
    map.set(domain, row);
  }
  return [...map.values()]
    .map((row) => ({ ...row, promptCount: row.prompts.size, prompts: undefined }))
    .sort((a, b) => b.citations - a.citations || b.sources - a.sources || a.domain.localeCompare(b.domain));
}

function buildQueryRows(runs) {
  const map = new Map();
  for (const run of runs) {
    const key = `${run.category}\u0000${run.prompt}`;
    const row = map.get(key) ?? {
      prompt: run.prompt,
      category: run.category,
      validRuns: 0,
      aiBrandMentionedRuns: 0,
      aiBrandMentionCount: 0,
      citations: 0,
      sources: new Map(),
      brandEvidenceSources: new Set(),
      exampleAnswer: null,
      brandAnswerExample: null,
    };
    row.validRuns += 1;
    if (run.aiBrandMentioned) {
      row.aiBrandMentionedRuns += 1;
      if (!row.brandAnswerExample && run.answerExcerpt) row.brandAnswerExample = run.answerExcerpt;
    }
    row.aiBrandMentionCount += num(run.aiBrandMentionCount);
    row.citations += run.citations.length;
    if (!row.exampleAnswer && run.answerExcerpt) row.exampleAnswer = run.answerExcerpt;
    for (const citation of run.citations) {
      const key2 = sourceKey(citation);
      const current = row.sources.get(key2) ?? { url: citation.canonicalUrl || citation.finalUrl || citation.originalUrl, title: citation.title, domain: citation.domain, citations: 0 };
      current.citations += 1;
      row.sources.set(key2, current);
      if (pageHasCurrentBrandEvidence(citation.page)) row.brandEvidenceSources.add(key2);
    }
    map.set(key, row);
  }

  return [...map.values()]
    .map((row) => ({
      prompt: row.prompt,
      category: row.category,
      validRuns: row.validRuns,
      aiBrandMentionedRuns: row.aiBrandMentionedRuns,
      aiBrandMentionRate: rate(row.aiBrandMentionedRuns, row.validRuns),
      aiBrandMentionCount: row.aiBrandMentionCount,
      citationCount: row.citations,
      uniqueSourceCount: row.sources.size,
      brandEvidenceSourceCount: row.brandEvidenceSources.size,
      topSources: [...row.sources.values()]
        .sort((a, b) => b.citations - a.citations || String(a.url ?? "").localeCompare(String(b.url ?? "")))
        .slice(0, 5),
      exampleAnswer: row.brandAnswerExample || row.exampleAnswer,
      exampleAnswerContainsBrand: Boolean(row.brandAnswerExample),
    }))
    .sort((a, b) =>
      (a.aiBrandMentionRate ?? 2) - (b.aiBrandMentionRate ?? 2) ||
      b.validRuns - a.validRuns ||
      a.prompt.localeCompare(b.prompt, "zh-CN"),
    );
}

/**
 * Query-centric citation intelligence. It deliberately reports co-observed sources for the
 * same AI answer; it does not claim a specific source caused a specific brand mention unless
 * the provider exposes sentence/source provenance.
 */
export async function buildBrandSourceIntelligence(pool, batchId) {
  const [jobResult, runResult] = await Promise.all([
    pool.query(
      `SELECT status AS batch_status,
              finished_at AS batch_finished_at,
              source_intelligence_generation AS generation,
              source_intelligence_status AS status,
              source_intelligence_queued_at AS queued_at,
              source_intelligence_started_at AS started_at,
              source_intelligence_finished_at AS finished_at,
              source_intelligence_error AS error,
              CASE
                WHEN status IN ('completed', 'partial')
                 AND finished_at IS NOT NULL
                 AND (
                   source_intelligence_finished_at IS NULL
                   OR source_intelligence_finished_at < finished_at
                 )
                THEN true ELSE false
              END AS stale
         FROM sampling_batches WHERE id = $1`,
      [batchId],
    ),
    pool.query(
      `SELECT r.id,
              r.local_run_id,
              pr.prompt,
              COALESCE(sbp.category, pr.category, 'uncategorized') AS category,
              r.brand_mentioned,
              r.mention_count,
              left(r.answer, 1400) AS answer_excerpt,
              COALESCE(
                jsonb_agg(
                  jsonb_build_object(
                    'sourcePosition', c.source_position,
                    'canonicalUrl', a.canonical_url,
                    'originalUrl', a.original_url,
                    'finalUrl', apo.final_url,
                    'title', COALESCE(apo.title_text, a.title),
                    'domain', a.normalized_domain,
                    'sourceType', c.source_type,
                    'relationStatus', c.relation_status,
                    'page', jsonb_build_object(
                      'fetchState', apo.fetch_state,
                      'contentExcerpt', apo.content_excerpt,
                      'contentProfile', apo.content_profile,
                      'outline', apo.heading_outline,
                      'paragraphCount', apo.paragraph_count,
                      'textLength', apo.text_length,
                      'h1Count', apo.h1_count,
                      'h2Count', apo.h2_count,
                      'h3Count', apo.h3_count,
                      'tableCount', apo.table_count,
                      'listCount', apo.list_count,
                      'faqHeadingCount', apo.faq_heading_count,
                      'authorPresent', apo.author_present,
                      'publishedAtRaw', apo.published_at_raw,
                      'modifiedAtRaw', apo.modified_at_raw,
                      'brandMentioned', apo.brand_mentioned,
                      'brandMentionCount', apo.brand_mention_count,
                      'brandFirstMentionPosition', apo.brand_first_mention_position,
                      'brandMatchedTerms', apo.brand_matched_terms,
                      'brandContexts', apo.brand_contexts,
                      'brandLocations', apo.brand_locations,
                      'brandDetectionVersion', apo.brand_detection_version
                    )
                  ) ORDER BY c.source_position NULLS LAST, c.id
                ) FILTER (WHERE c.id IS NOT NULL),
                '[]'::jsonb
              ) AS citations
         FROM runs r
         JOIN prompts pr ON pr.id = r.prompt_id
         LEFT JOIN LATERAL (
           SELECT category
             FROM sampling_batch_prompts sbp
            WHERE sbp.batch_id = r.sampling_batch_id
              AND sbp.prompt_id = r.prompt_id
              AND sbp.account_key IS NOT DISTINCT FROM r.account_key
            ORDER BY sbp.selection_index
            LIMIT 1
         ) sbp ON true
         LEFT JOIN citations c ON c.run_id = r.id AND c.visible_to_user IS NOT FALSE
         LEFT JOIN articles a ON a.id = c.article_id
         LEFT JOIN article_page_observations apo
           ON apo.batch_id = r.sampling_batch_id AND apo.article_id = a.id
        WHERE r.sampling_batch_id = $1 AND ${VALID_RUN_SQL}
        GROUP BY r.id, pr.prompt, pr.category, sbp.category
        ORDER BY r.id`,
      [batchId],
    ),
  ]);

  const rows = runResult.rows;
  const runs = rows.map((row) => ({
    id: Number(row.id),
    localRunId: row.local_run_id,
    prompt: row.prompt,
    category: row.category,
    aiBrandMentioned: row.brand_mentioned === true,
    aiBrandMentionCount: num(row.mention_count),
    answerExcerpt: row.answer_excerpt,
    citations: array(row.citations),
  }));
  const sources = buildSourceRows(runs);
  const brandEvidenceSources = sources.filter((row) => pageHasCurrentBrandEvidence(row.page));
  const analyzed = sources.filter((row) => pageHasAnalysis(row.page)).length;
  const job = jobResult.rows[0] ?? null;

  return {
    version: 1,
    job,
    runs,
    queries: buildQueryRows(runs),
    sources,
    domains: buildDomainRows(sources),
    brandEvidenceSources,
    structure: structureSummary(sources),
    coverage: {
      citedSources: sources.length,
      analyzedSources: analyzed,
      analysisRate: rate(analyzed, sources.length),
      brandEvidenceSources: brandEvidenceSources.length,
      brandEvidenceRate: rate(brandEvidenceSources.length, analyzed),
    },
    attributionNote: "引用页与品牌提及是在同一 AI 回答中共同观测到的证据；除非平台提供句子→来源 provenance，否则不把单个 URL 宣称为品牌提及的唯一原因。",
  };
}
