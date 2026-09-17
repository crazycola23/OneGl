import assert from "node:assert/strict";
import test from "node:test";

import { createPool } from "../src/db/pool.js";
import {
  deleteProjectCompetitor,
  listProjectCompetitors,
  loadBatchGeoIntelligence,
  loadProjectGeoIntelligence,
  upsertProjectCompetitor,
} from "../src/db/geo-intelligence.js";

const enabled = Boolean(process.env.DATABASE_URL);

test("GEO intelligence is re-derived from stored runs, queries, citations and competitor rules", { skip: !enabled }, async () => {
  const pool = createPool();
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const articleUrls = [`https://a.example/${suffix}`, `https://b.example/${suffix}`, `https://c.example/${suffix}`];
  let projectId = null;

  try {
    const project = await pool.query(
      `INSERT INTO projects (name, target_brand, brand_aliases)
       VALUES ($1, '品牌A', '["品牌A"]'::jsonb)
       RETURNING id`,
      [`geo_intel_${suffix}`],
    );
    projectId = project.rows[0].id;

    const prompt = await pool.query(
      `INSERT INTO prompts (project_id, prompt, enabled, category)
       VALUES ($1, '新能源SUV推荐', true, 'category') RETURNING id`,
      [projectId],
    );
    const promptId = prompt.rows[0].id;

    const batch = await pool.query(
      `INSERT INTO sampling_batches
         (project_id, name, provider, pool_size, sample_size, sampling_method, sampling_seed, repeats, status)
       VALUES ($1, $2, 'doubao', 1, 1, 'random', 'test-seed', 1, 'completed')
       RETURNING id`,
      [projectId, `batch_${suffix}`],
    );
    const batchId = batch.rows[0].id;

    const runRows = [];
    for (const [index, row] of [
      { answer: "品牌A和竞品B都值得考虑", brand: true, day: "2026-09-14T10:00:00Z" },
      { answer: "竞品B的表现更突出", brand: false, day: "2026-09-15T10:00:00Z" },
      {
        answer: "品牌A的空间表现不错，可参考 competitor-b.example 的公开资料",
        brand: true,
        day: "2026-09-15T12:00:00Z",
      },
    ].entries()) {
      const inserted = await pool.query(
        `INSERT INTO runs
           (prompt_id, provider, provider_access, model, status, started_at, finished_at, answer,
            captured_citation_count, citation_state, citation_diagnostics, local_run_id, sampling_batch_id,
            conversation_reset_confirmed, brand_mentioned, matched_terms, attempt, created_at)
         VALUES ($1, 'doubao', 'scraped', 'doubao', 'success', $2, $2, $3,
                 0, 'found', '[]'::jsonb, $4, $5, true, $6, '[]'::jsonb, 1, $2)
         RETURNING id`,
        [promptId, row.day, row.answer, `run_geo_${suffix}_${index}`, batchId, row.brand],
      );
      runRows.push(inserted.rows[0].id);
    }

    // A valid run after the requested project-window end must not leak into that window.
    await pool.query(
      `INSERT INTO runs
         (prompt_id, provider, provider_access, model, status, started_at, finished_at, answer,
          captured_citation_count, citation_state, citation_diagnostics, local_run_id,
          conversation_reset_confirmed, brand_mentioned, matched_terms, attempt, created_at)
       VALUES ($1, 'doubao', 'scraped', 'doubao', 'success', $2, $2, '品牌A未来观察',
               0, 'none_visible', '[]'::jsonb, $3, true, true, '[]'::jsonb, 1, $2)`,
      [promptId, "2026-09-20T10:00:00Z", `run_geo_${suffix}_future`],
    );

    await pool.query(
      `INSERT INTO run_search_queries (run_id, query_position, query_text) VALUES
       ($1, 1, '2026 新能源 SUV 推荐'),
       ($2, 1, '竞品B 新能源 SUV 对比'),
       ($3, 1, '新能源 SUV 续航 排名')`,
      runRows,
    );

    const articleIds = [];
    for (const [index, url] of articleUrls.entries()) {
      const domain = ["a.example", "b.example", "c.example"][index];
      const inserted = await pool.query(
        `INSERT INTO articles (canonical_url, original_url, domain, normalized_domain)
         VALUES ($1, $1, $2, $2) RETURNING id`,
        [url, domain],
      );
      articleIds.push(inserted.rows[0].id);
    }

    await pool.query(
      `INSERT INTO citations
         (run_id, article_id, source_position, relation_status, visible_to_user, source_type, created_at)
       VALUES
         ($1, $4, 1, 'unresolved', true, 'visible', '2026-09-14T10:00:00Z'),
         ($1, $5, 2, 'unresolved', true, 'visible', '2026-09-14T10:00:00Z'),
         ($2, $4, 1, 'unresolved', true, 'visible', '2026-09-15T10:00:00Z'),
         ($2, $6, 2, 'unresolved', true, 'visible', '2026-09-15T10:00:00Z'),
         ($3, $4, 1, 'unresolved', true, 'visible', '2026-09-15T12:00:00Z')`,
      [...runRows, ...articleIds],
    );

    const competitor = await upsertProjectCompetitor(pool, projectId, {
      name: "竞品B",
      aliases: ["竞品B"],
      domains: ["competitor-b.example"],
    });
    assert.equal((await listProjectCompetitors(pool, projectId)).length, 1);

    const intelligence = await loadBatchGeoIntelligence(pool, batchId);
    assert.equal(intelligence.scope.type, "batch");
    assert.equal(intelligence.ruleMode, "current-project-rules");
    assert.equal(intelligence.visibility.validRuns, 3);
    assert.equal(intelligence.visibility.brandMentions, 2);
    assert.equal(intelligence.visibility.rate, 2 / 3);
    assert.equal(intelligence.visibility.series.length, 2);
    assert.equal(intelligence.providers.length, 1);
    assert.equal(intelligence.providers[0].access, "scraped");
    assert.equal(intelligence.competitors[0].name, "竞品B");
    assert.equal(intelligence.competitors[0].mentions, 2);
    assert.equal(intelligence.shareOfVoice.brandShare, 0.5);
    assert.equal(intelligence.shareOfVoice.series.length, 2);
    assert.equal(intelligence.fanout.totalQueries, 3);
    assert.equal(intelligence.citations.validRuns, 3);
    assert.equal(intelligence.citations.coverage, 1);
    assert.equal(intelligence.citations.total, 5);
    assert.equal(intelligence.citations.stability.transitions, 1);
    assert.ok(intelligence.citations.stability.stabilityScore >= 0);
    assert.ok(intelligence.citations.topDomains.some((row) => row.domain === "a.example"));

    const projectWindow = await loadProjectGeoIntelligence(pool, projectId, {
      days: 7,
      now: new Date("2026-09-16T23:00:00Z"),
    });
    assert.equal(projectWindow.scope.type, "project-window");
    assert.equal(projectWindow.scope.days, 7);
    assert.equal(projectWindow.visibility.validRuns, 3);
    assert.deepEqual(projectWindow.visibility.series.map((row) => row.date), ["2026-09-14", "2026-09-15"]);
    assert.equal(projectWindow.citations.validRuns, 3);
    assert.equal(projectWindow.citations.stability.transitions, 1);

    assert.equal(await deleteProjectCompetitor(pool, projectId, competitor.id), true);
    assert.deepEqual(await listProjectCompetitors(pool, projectId), []);
  } finally {
    if (projectId) await pool.query("DELETE FROM projects WHERE id = $1").catch(() => undefined);
    await pool.query("DELETE FROM articles WHERE canonical_url = ANY($1::text[])", [articleUrls]).catch(() => undefined);
    await pool.end();
  }
});
