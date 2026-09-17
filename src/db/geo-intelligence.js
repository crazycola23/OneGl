import { compileBrandRules, detectBrandMention } from "../brand/detect.js";
import {
  buildGeoOpportunities,
  citationDifficulty,
  computeCitationVolatility,
  computeQueryFanout,
  computeShareOfVoice,
} from "../analysis/geo-intelligence.js";

const ANSWER_VALID_RUN = "r.status IN ('success', 'partial') AND r.conversation_reset_confirmed IS TRUE";

function jsonArray(value) {
  return Array.isArray(value) ? value : [];
}

function competitorRules(row) {
  return compileBrandRules({
    name: row.name,
    aliases: jsonArray(row.aliases),
    productAliases: [],
    excludePatterns: jsonArray(row.exclude_patterns),
  });
}

function citationCompleteRun(run) {
  return run?.status === "success" && new Set(["found", "none_visible"]).has(run?.citation_state);
}

function queryEvidenceUsable(run) {
  // API adapters can provide first-party query observations without browser-network capture.
  if (run?.provider_access === "api") return true;
  // Playwright's browser response body is buffered rather than a trustworthy live SSE
  // transport. For scraped runs, an empty capture cannot distinguish "no search happened"
  // from "the completion body never became observable". Fail closed: only positive,
  // structured retrieval evidence is eligible for query-fanout metrics.
  return run?.network_evidence_state === "found";
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

async function loadProject(pool, projectId) {
  const { rows } = await pool.query(
    `SELECT id AS project_id, name AS project_name, target_brand, brand_aliases,
            brand_product_aliases, brand_exclude_patterns
       FROM projects
      WHERE id = $1`,
    [projectId],
  );
  return rows[0] ?? null;
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

const RUN_SELECT = `
  SELECT r.id, r.prompt_id, p.prompt, r.provider,
         COALESCE(r.model, r.provider) AS model,
         COALESCE(r.provider_access, 'scraped') AS provider_access,
         r.model_version, r.answer, r.brand_mentioned, r.created_at,
         r.status, r.citation_state, r.network_evidence_state
    FROM runs r
    JOIN prompts p ON p.id = r.prompt_id
`;

async function loadBatchRuns(pool, batchId) {
  const { rows } = await pool.query(
    `${RUN_SELECT}
      WHERE r.sampling_batch_id = $1 AND ${ANSWER_VALID_RUN}
      ORDER BY r.id`,
    [batchId],
  );
  return rows;
}

async function loadProjectRuns(pool, projectId, since, until) {
  const { rows } = await pool.query(
    `${RUN_SELECT}
      WHERE p.project_id = $1
        AND r.created_at >= $2
        AND r.created_at <= $3
        AND ${ANSWER_VALID_RUN}
      ORDER BY r.id`,
    [projectId, since, until],
  );
  return rows;
}

function dayKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

async function buildIntelligence(pool, project, runs, scope) {
  const projectId = Number(project.project_id);
  const competitors = (await listProjectCompetitors(pool, projectId)).filter((row) => row.enabled);

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
  const dailyStats = new Map();
  const brandMentionByRunId = new Map();
  let brandMentions = 0;

  for (const run of runs) {
    const answer = String(run.answer ?? "");
    const brandMentioned = detectBrandMention(answer, brandRules).mentioned;
    brandMentionByRunId.set(String(run.id), brandMentioned);
    if (brandMentioned) brandMentions += 1;

    const date = dayKey(run.created_at);
    const daily = date
      ? (dailyStats.get(date) ?? { date, runs: 0, brandMentions: 0, competitorMentions: 0 })
      : null;
    if (daily) {
      daily.runs += 1;
      if (brandMentioned) daily.brandMentions += 1;
    }

    const promptId = String(run.prompt_id);
    if (queryEvidenceUsable(run)) {
      promptRunCounts.set(promptId, (promptRunCounts.get(promptId) ?? 0) + 1);
    }
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
      if (daily) daily.competitorMentions += 1;
      prompt.competitors.set(entry.row.name, (prompt.competitors.get(entry.row.name) ?? 0) + 1);
    }
    if (daily) dailyStats.set(date, daily);
    promptStats.set(promptId, prompt);

    const providerKey = `${run.provider}::${run.model}::${run.provider_access}::${run.model_version ?? "unknown"}`;
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
    providerStats.set(providerKey, target);
  }

  const citationRunIds = runs.filter(citationCompleteRun).map((run) => Number(run.id));
  const queryRunIds = runs.filter(queryEvidenceUsable).map((run) => Number(run.id));
  const { rows: queryRowsRaw } = await pool.query(
    `SELECT r.id AS run_id, r.prompt_id, p.prompt, q.query_text AS query
       FROM run_search_queries q
       JOIN runs r ON r.id = q.run_id
       JOIN prompts p ON p.id = r.prompt_id
      WHERE r.id = ANY($1::bigint[])
      ORDER BY r.id, q.query_position`,
    [queryRunIds],
  );
  const queryRows = queryRowsRaw.map((row) => ({
    ...row,
    brand_mentioned: brandMentionByRunId.get(String(row.run_id)) ?? false,
  }));
  const fanoutBase = computeQueryFanout(queryRows, { promptRunCounts });
  const queryCoverage = runs.length ? queryRunIds.length / runs.length : null;
  const fanout = {
    ...fanoutBase,
    validRuns: queryRunIds.length,
    coverage: queryCoverage,
    evidenceStatus:
      queryRunIds.length === 0
        ? "unavailable"
        : queryRunIds.length === runs.length
          ? "available"
          : "partial",
  };

  const { rows: dailyDomains } = await pool.query(
    `SELECT to_char((r.created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS date,
            a.normalized_domain AS domain,
            count(*)::int AS count
       FROM citations c
       JOIN runs r ON r.id = c.run_id
       JOIN articles a ON a.id = c.article_id
      WHERE r.id = ANY($1::bigint[])
        AND c.source_type = 'visible'
        AND c.visible_to_user IS TRUE
      GROUP BY 1, 2
      ORDER BY 1, 2`,
    [citationRunIds],
  );
  const stability = computeCitationVolatility(dailyDomains);

  const { rows: domainRows } = await pool.query(
    `SELECT a.normalized_domain AS domain, count(*)::int AS citations,
            count(DISTINCT r.id)::int AS runs
       FROM citations c
       JOIN runs r ON r.id = c.run_id
       JOIN articles a ON a.id = c.article_id
      WHERE r.id = ANY($1::bigint[])
        AND c.source_type = 'visible'
        AND c.visible_to_user IS TRUE
      GROUP BY 1
      ORDER BY citations DESC, domain`,
    [citationRunIds],
  );
  const totalCitations = domainRows.reduce((sum, row) => sum + Number(row.citations), 0);
  const topDomains = domainRows.slice(0, 25).map((row) => ({
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
  const visibilitySeries = [...dailyStats.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((row) => ({
      date: row.date,
      runs: row.runs,
      brandMentions: row.brandMentions,
      rate: row.runs ? row.brandMentions / row.runs : null,
    }));

  const shareOfVoiceBase = computeShareOfVoice(
    { name: project.target_brand ?? project.project_name, mentions: brandMentions },
    competitorEntries.map((entry) => ({ name: entry.row.name, mentions: entry.mentions })),
  );
  const shareOfVoice = {
    ...shareOfVoiceBase,
    series: [...dailyStats.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((row) => {
        const total = row.brandMentions + row.competitorMentions;
        return {
          date: row.date,
          brandMentions: row.brandMentions,
          competitorMentions: row.competitorMentions,
          share: total ? row.brandMentions / total : null,
        };
      }),
  };
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
    scope,
    project: {
      id: projectId,
      name: project.project_name,
      targetBrand: project.target_brand,
    },
    ruleMode: "current-project-rules",
    visibility: {
      validRuns: runs.length,
      brandMentions,
      rate: visibilityRate,
      series: visibilitySeries,
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
      validRuns: citationRunIds.length,
      coverage: runs.length ? citationRunIds.length / runs.length : null,
      total: totalCitations,
      topDomains,
      stability: { ...stability, difficulty: citationDifficulty(stability.stabilityScore) },
    },
    promptGaps,
    opportunities,
  };
}

export async function loadBatchGeoIntelligence(pool, batchId) {
  const project = await loadBatchProject(pool, batchId);
  if (!project) return null;
  const runs = await loadBatchRuns(pool, batchId);
  return buildIntelligence(pool, project, runs, {
    type: "batch",
    batchId: Number(project.batch_id),
    batchName: project.batch_name,
  });
}

export async function loadProjectGeoIntelligence(pool, projectId, { days = 30, now = new Date() } = {}) {
  const normalizedDays = Math.max(1, Math.min(365, Number(days) || 30));
  const project = await loadProject(pool, projectId);
  if (!project) return null;
  const until = new Date(now);
  const since = new Date(until.getTime() - normalizedDays * 86_400_000);
  const runs = await loadProjectRuns(pool, projectId, since, until);
  return buildIntelligence(pool, project, runs, {
    type: "project-window",
    days: normalizedDays,
    from: since.toISOString(),
    to: until.toISOString(),
  });
}
