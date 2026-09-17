import assert from "node:assert/strict";
import test from "node:test";

import { countOverview } from "../src/db/dashboard.js";
import { createPool } from "../src/db/pool.js";

const enabled = Boolean(process.env.DATABASE_URL);

test("dashboard overview counts only citation-valid user-visible sources", { skip: !enabled }, async () => {
  const pool = createPool();
  const client = await pool.connect();
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;

  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const before = await countOverview(client);

    const project = await client.query(
      `INSERT INTO projects (name, target_brand)
       VALUES ($1, 'Overview Brand') RETURNING id`,
      [`overview_${suffix}`],
    );
    const projectId = project.rows[0].id;

    const prompt = await client.query(
      `INSERT INTO prompts (project_id, prompt, enabled, category)
       VALUES ($1, 'overview citation eligibility', true, 'test') RETURNING id`,
      [projectId],
    );
    const promptId = prompt.rows[0].id;

    const successRun = await client.query(
      `INSERT INTO runs
         (prompt_id, provider, provider_access, model, status, started_at, finished_at, answer,
          captured_citation_count, citation_state, citation_diagnostics, network_evidence_state,
          local_run_id, conversation_reset_confirmed, brand_mentioned, matched_terms, attempt, created_at)
       VALUES ($1, 'doubao', 'scraped', 'doubao', 'success', now(), now(), 'authoritative answer',
               1, 'found', '[]'::jsonb, 'disabled', $2, true, true, '[]'::jsonb, 1, now())
       RETURNING id`,
      [promptId, `overview_${suffix}_success`],
    );

    const partialRun = await client.query(
      `INSERT INTO runs
         (prompt_id, provider, provider_access, model, status, started_at, finished_at, answer,
          captured_citation_count, citation_state, citation_diagnostics, network_evidence_state,
          local_run_id, conversation_reset_confirmed, brand_mentioned, matched_terms, attempt, created_at)
       VALUES ($1, 'doubao', 'scraped', 'doubao', 'partial', now(), now(), 'partial answer',
               9, 'parse_failed', '["forced-partial"]'::jsonb, 'disabled', $2, true, true,
               '[]'::jsonb, 1, now())
       RETURNING id`,
      [promptId, `overview_${suffix}_partial`],
    );

    const articleIds = [];
    for (const kind of ["valid", "partial", "network"]) {
      const url = `https://overview-${kind}.example/${suffix}`;
      const domain = new URL(url).hostname;
      const inserted = await client.query(
        `INSERT INTO articles (canonical_url, original_url, domain, normalized_domain)
         VALUES ($1, $1, $2, $2) RETURNING id`,
        [url, domain],
      );
      articleIds.push(inserted.rows[0].id);
    }

    await client.query(
      `INSERT INTO citations
         (run_id, article_id, source_position, relation_status, visible_to_user, source_type)
       VALUES
         ($1, $3, 1, 'unresolved', true, 'visible'),
         ($2, $4, 1, 'unresolved', true, 'visible'),
         ($1, $5, 2, 'unresolved', false, 'network')`,
      [successRun.rows[0].id, partialRun.rows[0].id, ...articleIds],
    );

    const after = await countOverview(client);
    assert.equal(Number(after.citations) - Number(before.citations), 1);
    assert.equal(Number(after.articles) - Number(before.articles), 1);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    await pool.end();
  }
});
