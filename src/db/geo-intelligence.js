import { compileBrandRules, detectBrandMention } from "../brand/detect.js";
import {
  buildGeoOpportunities,
  citationDifficulty,
  computeCitationVolatility,
  computeQueryFanout,
  computeShareOfVoice,
} from "../analysis/geo-intelligence.js";

const VALID_RUN = "r.status IN ('success', 'partial') AND r.conversation_reset_confirmed IS TRUE";

function jsonArray(value) {
  return Array.isArray(value) ? value : [];
}

function competitorRules(row) {
  return compileBrandRules({
    name: row.name,
    aliases: [...jsonArray(row.aliases), ...jsonArray(row.domains)],
    productAliases: [],
    excludePatterns: jsonArray(row.exclude_patterns),
  });
}

export async function listProjectCompetitors(pool, projectId) {
  const { rows } = await pool.query(
    `SELECT id, project_id, name, aliases, domains, exclude_patterns, enabled, created_at, updated_at
       FROM project_competitors
      WHERE project_id = $1
      ORDER BY enabled DESC, name, id`,
    [projectId],
  );
  return rows.map((row) => ({ ...row, id: Number(row.id), project_id: Number(row.project_id) }));
}

export async function upsertProjectCompetitor(pool, projectId, input = {}) {
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("competitor name is required");
  const aliases = jsonArray(input.aliases).map(String).map((value) => value.trim()).filter(Boolean);
  const domains = jsonArray(input.domains).map(String).map((value) => value.trim()).filter(Boolean);
  const excludePatterns = jsonArray(input.exclude_patterns ?? input.excludePatterns)
    .map(String)
    .map((value) => value.trim())
    .filter(Boolean);
  const enabled = input.enabled !== false;

  const { rows } = await pool.query(
    `INSERT INTO project_competitors (project_id, name, aliases, domains, exclude_patterns, enabled)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6)
     ON CONFLICT (project_id, name) DO UPDATE
       SET aliases = EXCLUDED.aliases,
           domains = EXCLUDED.domains,
           exclude_patterns = EXCLUDED.exclude_patterns,
           enabled = EXCLUDED.enabled,
           updated_at = now()
     RETURNING id, project_id, name, aliases, domains, exclude_patterns, enabled, created_at, updated_at`,
    [projectId, name, JSON.stringify(aliases), JSON.stringify(domains), JSON.stringify(excludePatterns), enabled],
  );
  const row = rows[0];
  return { ...row, id: Number(row.id), project_id: Number(row.project_id) };
}

export async function deleteProjectCompetitor(pool, projectId, competitorId) {
  const result = await pool.query(
    "DELETE FROM project_competitors WHERE project_id = $1 AND id = $2",
    [projectId, competitorId],
  );
  return result.rowCount > 0;
}

async function loadBatchProject(pool, batchId) {
  const { rows } = await pool.query(
    `SELECT b.id AS batch_id, b.project_id, b.name AS batch_name,
            p.name AS project_name, p.target_brand, p.brand_aliases,
            p.brand_product_aliases, p.brand_exclude_patterns
       FROM sampling_batches b
       JOIN projects p ON p.id = b.project_id
      WHERE b.id = $1`,
    [batchId],
  );
  return rows[0] ?? null;
}

/**
 * Re-derives GEO analytics from auditable raw runs/search queries/citations.
 * Competitor mentions are intentionally computed on read so adding a competitor
 * immediately works against historical answers without rewriting old runs.
 */
export async function loadBatchGeoIntelligence(pool, batchId) {
  const project = await loadBatchProject(pool, batchId);
  if (!project) return null;
  const competitors = (await listProjectCompetitors(pool, project.project_id)).filter((row) => row.enabled);

  const { rows: runs } = await pool.query(
    `SELECT r.id, r.prompt_id, p.prompt, r.provider,
            COALESCE(r.model, r.provider) AS model,
            COALESCE(r.provider_access, 'scraped') AS provider_access,
            r.model_version, r.answer, r.brand_mentioned, r.created_at
       FROM runs r
       JOIN prompts p ON p.id = r.prompt_id
      WHERE r.sampling_batch_id = $1 AND ${VALID_RUN}
      ORDER BY r.id`,
    [batchId],
  );

  const brandRules = compileBrandRules({
    name: project.target_brand ?? project.project_name,
    aliases: jsonArray(project.brand_aliases),
    productAliases: jsonArray(project.brand_product_aliases),
    excludePatterns: jsonArray(project.brand_exclude_patterns),
  });
  const competitorEntries = competitors.map((row) => ({ row, rules: competitorRules(row), mentions: 0 }));
  const promptStats = new Map();
  const providerStats = new Map();
  const promptRunCounts = new Map();
  let brandMentions = 0;

  for (const run of runs) {
    const answer = String(run.answer ?? "");
    const brandMentioned = typeof run.brand_mentioned === "boolean"
      ? run.brand_mentioned
      : detectBrandMention(answer, brandRules).mentioned;
    if (brandMentioned) brandMentions += 1;

    const promptId = String(run.prompt_id);
    promptRunCounts.set(promptId, (promptRunCounts.get(promptId) ?? 0) + 1);
    const prompt = promptStats.get(promptId) ?? {
      promptId,
      prompt: run.prompt,
      validRuns: 0,
      brandMentions: 0,
      competitors: new Map(),
    };
    prompt.validRuns += 1;
    if (brandMentioned) prompt.brandMentions += 1;

    for (const entry of competitorEntries) {
      if (!detectBrandMention(answer, entry.rules).mentioned) continue;
      entry.mentions += 1;
      prompt.competitors.set(entry.row.name, (prompt.competitors.get(entry.row.name) ?? 0) + 1);
    }
    promptStats.set(promptId, prompt);

    const providerKey = `${run.provider}::${run.model}::${run.provider_access}`;
    const target = providerStats.get(providerKey) ?? {
      provider: run.provider,
      model: run.model,
      access: run.provider_access,
      modelVersion: run.model_version ?? null,
      runs: 0,
      brandMentions: 0,
    };
    target.runs += 1;
    if (brandMentioned) target.brandMentions += 1;
    if (!target.modelVersion && run.model_version) target.modelVersion = run.model_version;
    providerStats.set(providerKey, target);
  }

  const { rows: queryRows } = await pool.query(
    `SELECT r.prompt_id, p.prompt, q.query_text AS query, r.brand_mentioned
       FROM run_search_queries q
       JOIN runs r ON r.id = q.run_id
       JOIN prompts p ON p.id = r.prompt_id
      WHERE r.sampling_batch_id = $1 AND ${VALID_RUN}
      ORDER BY r.id, q.query_position`,
    [batchId],
  );
  const fanout = computeQueryFanout(queryRows, { promptRunCounts });

  const { rows: dailyDomains } = await pool.query(
    `SELECT to_char((r.created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS date,
            a.normalized_domain AS domain,
            count(*)::int AS count
       FROM citations c
       JOIN runs r ON r.id = c.run_id
       JOIN articles a ON a.id = c.article_id
      WHERE r.sampling_batch_id = $1
        AND ${VALID_RUN}
        AND c.source_type = 'visible'
        AND c.visible_to_user IS TRUE
      GROUP BY 1, 2
      ORDER BY 1, 2`,
    [batchId],
  );
  const stability = computeCitationVolatility(dailyDomains);

  const { rows: domainRows } = await pool.query(
    `SELECT a.normalized_domain AS domain, count(*)::int AS citations,
            count(DISTINCT r.id)::int AS runs
       FROM citations c
       JOIN runs r ON r.id = c.run_id
       JOIN articles a ON a.id = c.article_id
      WHERE r.sampling_batch_id = $1
        AND ${VALID_RUN}
        AND c.source_type = 'visible'
        AND c.visible_to_user IS TRUE
      GROUP BY 1
      ORDER BY citations DESC, domain
      LIMIT 25`,
    [batchId],
  );
  const totalCitations = domainRows.reduce((sum, row) => sum + Number(row.citations), 0);
  const topDomains = domainRows.map((row) => ({
    domain: row.domain,
    citations: Number(row.citations),
    runs: Number(row.runs),
    share: totalCitations ? Number(row.citations) / totalCitations : 0,
  }));

  const promptGaps = [...promptStats.values()].map((row) => {
    const brandRate = row.validRuns ? row.brandMentions / row.validRuns : null;
    let leader = null;
    for (const [name, mentions] of row.competitors) {
      const rate = row.validRuns ? mentions / row.validRuns : 0;
      if (!leader || rate > leader.rate) leader = { name, mentions, rate };
    }
    return {
      promptId: row.promptId,
      prompt: row.prompt,
      validRuns: row.validRuns,
      brandMentions: row.brandMentions,
      brandRate,
      competitor: leader?.name ?? null,
      competitorMentions: leader?.mentions ?? 0,
      competitorRate: leader?.rate ?? null,
      gap: leader == null || brandRate == null ? null : leader.rate - brandRate,
    };
  }).sort((a, b) => (b.gap ?? -2) - (a.gap ?? -2) || b.validRuns - a.validRuns);

  const visibilityRate = runs.length ? brandMentions / runs.length : null;
  const shareOfVoice = computeShareOfVoice(
    { name: project.target_brand ?? project.project_name, mentions: brandMentions },
    competitorEntries.map((entry) => ({ name: entry.row.name, mentions: entry.mentions })),
  );
  const providers = [...providerStats.values()].map((row) => ({
    ...row,
    visibilityRate: row.runs ? row.brandMentions / row.runs : null,
  })).sort((a, b) => b.runs - a.runs || a.model.localeCompare(b.model));

  const opportunities = buildGeoOpportunities({
    visibilityRate,
    shareOfVoice,
    fanout,
    stability,
    topDomains,
    promptGaps,
  });

  return {
    batch: {
      id: Number(project.batch_id),
      name: project.batch_name,
      projectId: Number(project.project_id),
      projectName: project.project_name,
      targetBrand: project.target_brand,
    },
    visibility: {
      validRuns: runs.length,
      brandMentions,
      rate: visibilityRate,
    },
    providers,
    shareOfVoice,
    competitors: competitorEntries.map((entry) => ({
      id: entry.row.id,
      name: entry.row.name,
      mentions: entry.mentions,
      mentionRate: runs.length ? entry.mentions / runs.length : null,
    })),
    fanout,
    citations: {
      total: totalCitations,
      topDomains,
      stability: { ...stability, difficulty: citationDifficulty(stability.stabilityScore) },
    },
    promptGaps,
    opportunities,
  };
}
