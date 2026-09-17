import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import test from "node:test";

import { createPool } from "../src/db/pool.js";

const DATABASE_URL = process.env.DATABASE_URL;

function publicId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function startApi(port) {
  const child = spawn(process.execPath, ["src/api-entry.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ONEGL_API_HOST: "127.0.0.1",
      ONEGL_API_PORT: String(port),
      ONEGL_API_KEY: "customer-dashboard-test-key",
      REDIS_URL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  return { child, output: () => ({ stdout, stderr }) };
}

async function waitReady(proc, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.output().stdout.includes("OneGl Service API:")) return;
    if (proc.child.exitCode !== null) {
      const out = proc.output();
      throw new Error(`API exited early\n${out.stdout}\n${out.stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const out = proc.output();
  throw new Error(`API did not start\n${out.stdout}\n${out.stderr}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}

async function request(base, path, tenant = "default") {
  const response = await fetch(`${base}${path}`, {
    headers: {
      authorization: "Bearer customer-dashboard-test-key",
      "x-onegl-tenant": tenant,
    },
  });
  return { response, payload: await response.json() };
}

test("customer dashboard exposes front-end GEO metrics without internal IDs and stays tenant isolated", { skip: !DATABASE_URL }, async () => {
  const pool = createPool();
  const suffix = crypto.randomUUID().slice(0, 8);
  const taskId = publicId("tsk");
  const otherTenantSlug = `dashboard-other-${suffix}`;
  const port = 36500 + (process.pid % 500);
  const proc = startApi(port);
  let projectId = null;
  const articleUrls = [
    `https://dash-a.example/${suffix}`,
    `https://dash-b.example/${suffix}`,
    `https://dash-c.example/${suffix}`,
  ];

  try {
    const tenant = (await pool.query("SELECT id FROM service_tenants WHERE slug = 'default'")).rows[0];
    assert.ok(tenant?.id);
    await pool.query("INSERT INTO service_tenants (slug, name) VALUES ($1, $2)", [otherTenantSlug, `Other ${suffix}`]);

    const project = await pool.query(
      `INSERT INTO projects (name, target_brand, brand_aliases)
       VALUES ($1, '品牌A', '["品牌A"]'::jsonb)
       RETURNING id`,
      [`dashboard_project_${suffix}`],
    );
    projectId = Number(project.rows[0].id);

    const prompt = await pool.query(
      `INSERT INTO prompts (project_id, prompt, enabled, category)
       VALUES ($1, '新能源SUV推荐', true, 'category') RETURNING id`,
      [projectId],
    );
    const promptId = Number(prompt.rows[0].id);

    const batch = await pool.query(
      `INSERT INTO sampling_batches
         (project_id, name, provider, pool_size, sample_size, sampling_method, sampling_seed, repeats, status)
       VALUES ($1, $2, 'doubao', 1, 1, 'random', 'dashboard-seed', 1, 'completed')
       RETURNING id`,
      [projectId, `dashboard_batch_${suffix}`],
    );
    const batchId = Number(batch.rows[0].id);

    const runRows = [];
    for (const [index, row] of [
      { answer: "品牌A和竞品B都值得考虑", brand: true, day: "2026-09-14T10:00:00Z", citations: 2 },
      { answer: "竞品B更常被提到", brand: false, day: "2026-09-15T10:00:00Z", citations: 2 },
      { answer: "品牌A的空间表现不错", brand: true, day: "2026-09-15T12:00:00Z", citations: 1 },
    ].entries()) {
      const inserted = await pool.query(
        `INSERT INTO runs
           (prompt_id, provider, provider_access, model, status, started_at, finished_at, answer,
            citation_state, expected_citation_count, captured_citation_count, citation_diagnostics,
            local_run_id, sampling_batch_id, conversation_reset_confirmed, brand_mentioned,
            matched_terms, attempt, created_at)
         VALUES ($1, 'doubao', 'scraped', 'doubao', 'success', $2, $2, $3,
                 'found', $4, $4, '[]'::jsonb, $5, $6, true, $7, '[]'::jsonb, 1, $2)
         RETURNING id`,
        [promptId, row.day, row.answer, row.citations, `run_dashboard_${suffix}_${index}`, batchId, row.brand],
      );
      runRows.push(Number(inserted.rows[0].id));
    }

    await pool.query(
      `INSERT INTO run_search_queries (run_id, query_position, query_text) VALUES
       ($1, 1, '2026 新能源 SUV 推荐'),
       ($2, 1, '竞品B 新能源 SUV 对比'),
       ($3, 1, '新能源 SUV 续航 排名')`,
      runRows,
    );

    const articleIds = [];
    for (const [index, url] of articleUrls.entries()) {
      const domain = ["dash-a.example", "dash-b.example", "dash-c.example"][index];
      const inserted = await pool.query(
        `INSERT INTO articles (canonical_url, original_url, domain, normalized_domain)
         VALUES ($1, $1, $2, $2) RETURNING id`,
        [url, domain],
      );
      articleIds.push(Number(inserted.rows[0].id));
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

    await pool.query(
      `INSERT INTO project_competitors (project_id, name, aliases, domains, exclude_patterns, enabled)
       VALUES ($1, '竞品B', '["竞品B"]'::jsonb, '[]'::jsonb, '[]'::jsonb, true)`,
      [projectId],
    );

    await pool.query(
      `INSERT INTO service_tasks
         (public_id, tenant_id, project_id, external_id, name, target_brand, platforms, account_ids, sampling_method, repeats)
       VALUES ($1, $2, $3, $4, $5, '品牌A', '["doubao"]'::jsonb, '[]'::jsonb, 'stratified', 1)`,
      [taskId, tenant.id, projectId, `saas-${suffix}`, `客户 Dashboard ${suffix}`],
    );

    await waitReady(proc);
    const base = `http://127.0.0.1:${port}`;

    const specResponse = await fetch(`${base}/openapi.json`);
    assert.equal(specResponse.status, 200);
    const spec = await specResponse.json();
    assert.ok(spec.paths["/v1/tasks/{taskId}/dashboard"]?.get);
    assert.ok(spec.components.schemas.CustomerDashboardResource);

    const dashboard = await request(base, `/v1/tasks/${taskId}/dashboard?days=7&question_limit=20`);
    assert.equal(dashboard.response.status, 200);
    const data = dashboard.payload.data;
    assert.equal(data.task.task_id, taskId);
    assert.equal(data.task.target_brand, "品牌A");
    assert.equal(data.overview.valid_runs, 3);
    assert.equal(data.overview.brand_mentions, 2);
    assert.equal(data.overview.visibility_rate, 2 / 3);
    assert.equal(data.overview.share_of_voice, 0.5);
    assert.equal(data.overview.citation_valid_runs, 3);
    assert.equal(data.overview.citation_evidence_coverage_rate, 1);
    assert.equal(data.overview.visible_citations, 5);
    assert.equal(data.overview.cited_domains, 3);
    assert.equal(data.overview.query_fanout_total, 3);
    assert.equal(data.competitors[0].name, "竞品B");
    assert.equal(data.competitors[0].mentions, 2);
    assert.equal(data.citations.top_domains[0].domain, "dash-a.example");
    assert.equal(data.questions[0].question, "新能源SUV推荐");
    assert.equal(data.latest_execution, null);
    assert.equal(data.meta.questions_truncated, false);

    const serialized = JSON.stringify(data);
    for (const forbidden of ["project_id", "batch_id", "prompt_id", "storageState", "storage_state", "account_key"]) {
      assert.equal(serialized.includes(forbidden), false, `dashboard leaked ${forbidden}`);
    }

    const invalid = await request(base, `/v1/tasks/${taskId}/dashboard?question_limit=0`);
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.payload.error, "invalid_request");

    const isolated = await request(base, `/v1/tasks/${taskId}/dashboard`, otherTenantSlug);
    assert.equal(isolated.response.status, 404);
    assert.equal(isolated.payload.error, "task_not_found");
  } finally {
    await stop(proc.child);
    if (projectId) await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM articles WHERE canonical_url = ANY($1::text[])", [articleUrls]).catch(() => undefined);
    await pool.query("DELETE FROM service_tenants WHERE slug = $1", [otherTenantSlug]).catch(() => undefined);
    await pool.end();
  }
});
