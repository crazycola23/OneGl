import assert from "node:assert/strict";
import test from "node:test";

import { createPool } from "../src/db/pool.js";
import { loadBatchDoubaoSourceSignals, loadProjectDoubaoSourceSignals } from "../src/db/doubao-source-signals.js";

const enabled = Boolean(process.env.DATABASE_URL);

test("Doubao sourceContent uses only visible valid cited pages in the requested window", { skip: !enabled }, async () => {
  const pool = createPool();
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  let projectId = null;
  const urls = [`https://source-a.example/${suffix}`, `https://source-b.example/${suffix}`];

  try {
    const project = await pool.query(
      "INSERT INTO projects (name, target_brand) VALUES ($1, '品牌A') RETURNING id",
      [`source_signal_${suffix}`],
    );
    projectId = Number(project.rows[0].id);

    const prompt = await pool.query(
      "INSERT INTO prompts (project_id, prompt, enabled) VALUES ($1, '品牌A怎么样', true) RETURNING id",
      [projectId],
    );
    const promptId = Number(prompt.rows[0].id);

    const batch = await pool.query(
      `INSERT INTO sampling_batches
         (project_id, name, provider, pool_size, sample_size, sampling_method, sampling_seed, repeats, status)
       VALUES ($1, $2, 'doubao', 1, 1, 'random', 'source-signal', 1, 'completed')
       RETURNING id`,
      [projectId, `source_batch_${suffix}`],
    );
    const batchId = Number(batch.rows[0].id);

    const run = await pool.query(
      `INSERT INTO runs
         (prompt_id, provider, provider_access, model, status, started_at, finished_at, answer,
          captured_citation_count, citation_diagnostics, local_run_id, sampling_batch_id,
          conversation_reset_confirmed, brand_mentioned, matched_terms, attempt, created_at)
       VALUES ($1, 'doubao', 'scraped', 'doubao', 'success', $2, $2, '品牌A值得考虑',
               1, '[]'::jsonb, $3, $4, true, true, '["品牌A"]'::jsonb, 1, $2)
       RETURNING id`,
      [promptId, "2026-09-15T10:00:00Z", `run_source_${suffix}`, batchId],
    );
    const runId = Number(run.rows[0].id);

    const articleIds = [];
    for (const [index, url] of urls.entries()) {
      const domain = index === 0 ? "source-a.example" : "source-b.example";
      const article = await pool.query(
        `INSERT INTO articles (canonical_url, original_url, domain, normalized_domain)
         VALUES ($1, $1, $2, $2) RETURNING id`,
        [url, domain],
      );
      articleIds.push(Number(article.rows[0].id));
    }

    // Only article A is a visible citation. Article B has page evidence but is not cited and
    // therefore must never influence the cited-page product signals.
    await pool.query(
      `INSERT INTO citations
         (run_id, article_id, source_position, relation_status, visible_to_user, source_type, created_at)
       VALUES ($1, $2, 1, 'unresolved', true, 'visible', $3)`,
      [runId, articleIds[0], "2026-09-15T10:00:00Z"],
    );

    await pool.query(
      `INSERT INTO article_page_observations
         (batch_id, article_id, requested_url, final_url, fetch_state, content_type,
          text_length, h2_count, table_count, list_count, faq_heading_count,
          author_present, published_at_raw, content_profile, brand_mentioned)
       VALUES
         ($1, $2, $4, $4, 'success', 'text/html', 3200, 4, 1, 1, 1, true, '2026-09-01', '{"type":"guide"}'::jsonb, true),
         ($1, $3, $5, $5, 'success', 'text/html', 9000, 20, 10, 10, 10, true, '2026-09-01', '{"type":"spam"}'::jsonb, false)`,
      [batchId, articleIds[0], articleIds[1], urls[0], urls[1]],
    );

    const exact = await loadBatchDoubaoSourceSignals(pool, batchId);
    assert.equal(exact.citedPages, 1);
    assert.equal(exact.analyzedPages, 1);
    assert.equal(exact.brandEvidenceRate, 1);
    assert.deepEqual(exact.contentTypes, [{ label: "guide", count: 1 }]);

    const window = await loadProjectDoubaoSourceSignals(pool, projectId, {
      from: "2026-09-14T00:00:00Z",
      to: "2026-09-16T00:00:00Z",
    });
    assert.equal(window.citedPages, 1);
    assert.equal(window.analyzedPages, 1);
    assert.equal(window.brandEvidenceRuleMode, "capture-time-page-evidence");

    const outside = await loadProjectDoubaoSourceSignals(pool, projectId, {
      from: "2026-09-16T00:00:01Z",
      to: "2026-09-17T00:00:00Z",
    });
    assert.equal(outside.citedPages, 0);
    assert.equal(outside.analyzedPages, 0);
  } finally {
    if (projectId) await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM articles WHERE canonical_url = ANY($1::text[])", [urls]).catch(() => undefined);
    await pool.end();
  }
});
