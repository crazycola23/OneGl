function rate(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function num(value) {
  return Number(value ?? 0);
}

function analyzed(row) {
  return Boolean(
    row?.fetch_state === "success" &&
    row?.content_profile &&
    typeof row.content_profile === "object" &&
    Object.keys(row.content_profile).length > 0,
  );
}

function sortedCounts(map) {
  return [...map.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "zh-CN"));
}

/**
 * Summarize observable page traits among pages Doubao visibly cited.
 * These are correlations/patterns, not claims that a page feature caused citation.
 */
export function summarizeDoubaoSourceSignals(rows = []) {
  const observed = rows.filter(analyzed);
  const types = new Map();
  let withH2 = 0;
  let withTable = 0;
  let withList = 0;
  let withFaq = 0;
  let withAuthor = 0;
  let withPublishedDate = 0;
  let brandEvidence = 0;
  let textLengthTotal = 0;
  let h2Total = 0;

  for (const row of observed) {
    const type = String(row.content_profile?.type ?? "unclassified");
    types.set(type, (types.get(type) ?? 0) + 1);
    if (num(row.h2_count) > 0) withH2 += 1;
    if (num(row.table_count) > 0) withTable += 1;
    if (num(row.list_count) > 0) withList += 1;
    if (num(row.faq_heading_count) > 0) withFaq += 1;
    if (row.author_present === true) withAuthor += 1;
    if (row.published_at_raw) withPublishedDate += 1;
    if (row.brand_mentioned === true) brandEvidence += 1;
    textLengthTotal += num(row.text_length);
    h2Total += num(row.h2_count);
  }

  const total = observed.length;
  const metrics = {
    citedPages: rows.length,
    analyzedPages: total,
    analysisCoverageRate: rate(total, rows.length),
    brandEvidencePages: brandEvidence,
    brandEvidenceRate: rate(brandEvidence, total),
    withH2Rate: rate(withH2, total),
    withTableRate: rate(withTable, total),
    withListRate: rate(withList, total),
    withFaqRate: rate(withFaq, total),
    withAuthorRate: rate(withAuthor, total),
    withPublishedDateRate: rate(withPublishedDate, total),
    averageTextLength: total ? Math.round(textLengthTotal / total) : null,
    averageH2Count: total ? h2Total / total : null,
    contentTypes: sortedCounts(types),
  };

  const patterns = [];
  if (total >= 3) {
    const candidates = [
      ["二级标题", metrics.withH2Rate],
      ["表格", metrics.withTableRate],
      ["列表", metrics.withListRate],
      ["FAQ/问答式标题", metrics.withFaqRate],
      ["作者信息", metrics.withAuthorRate],
      ["发布日期", metrics.withPublishedDateRate],
    ];
    for (const [label, value] of candidates) {
      if (value == null || value < 0.5) continue;
      patterns.push({
        trait: label,
        observedRate: value,
        samplePages: total,
        note: `在已分析的豆包可见引用页中，约 ${Math.round(value * 100)}% 观察到${label}。这是共现特征，不代表因果。`,
      });
    }
  }

  const opportunities = [];
  if (total >= 5 && (metrics.brandEvidenceRate ?? 1) < 0.3) {
    opportunities.push({
      category: "cited-page-brand-evidence",
      priority: 1 - metrics.brandEvidenceRate,
      title: "检查高频豆包引用页中的品牌证据缺口",
      why: `已分析 ${total} 个豆包引用页，其中只有 ${Math.round((metrics.brandEvidenceRate ?? 0) * 100)}% 能观察到目标品牌证据。`,
      evidence: { analyzedPages: total, brandEvidenceRate: metrics.brandEvidenceRate },
      guardrail: "先核对具体页面与上下文，再决定内容或外联动作；该指标不证明品牌出现会导致被引用。",
    });
  }

  if (total >= 5 && patterns.length) {
    opportunities.push({
      category: "cited-page-pattern-review",
      priority: 0.5,
      title: "复核豆包高频引用页的共同内容结构",
      why: `已有 ${total} 个可分析引用页，可用真实页面证据复核常见结构，而不是凭经验猜测 GEO 模板。`,
      evidence: { patterns: patterns.slice(0, 6) },
      guardrail: "这里只建议研究共现模式，不直接把 FAQ、表格、标题层级等特征解释为引用原因。",
    });
  }

  return {
    ...metrics,
    evidenceQuality: total >= 10 && (metrics.analysisCoverageRate ?? 0) >= 0.6
      ? "strong-observational"
      : total >= 3
        ? "limited-observational"
        : "insufficient-data",
    patterns,
    opportunities,
    attributionNote: "页面结构、品牌证据与豆包引用是在同一观测窗口中共同出现的证据；OneGl 不把这些相关性描述成豆包内部排序或引用公式。",
  };
}
