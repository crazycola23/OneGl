import assert from "node:assert/strict";
import test from "node:test";

import { createPool } from "../src/db/pool.js";
import {
  createMonitorPlan,
  listMonitorExecutions,
  materializeDueMonitorExecutions,
} from "../src/monitoring/plans.js";

const enabled = Boolean(process.env.DATABASE_URL);

test("monitor plans materialize each due occurrence once and advance the schedule", { skip: !enabled }, async () => {
  const pool = createPool();
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  let projectId = null;
  let tenantId = null;

  try {
    const tenant = await pool.query(
      "INSERT INTO service_tenants (slug, name) VALUES ($1, $2) RETURNING id",
      [`monitor_${suffix}`.replace(/[^a-z0-9_]/g, "_"), `Monitor ${suffix}`],
    );
    tenantId = Number(tenant.rows[0].id);

    const project = await pool.query(
      "INSERT INTO projects (name, target_brand) VALUES ($1, '测试品牌') RETURNING id",
      [`monitor_project_${suffix}`],
    );
    projectId = Number(project.rows[0].id);
    await pool.query(
      "INSERT INTO service_project_bindings (project_id, tenant_id, display_name) VALUES ($1, $2, $3)",
      [projectId, tenantId, `监测项目 ${suffix}`],
    );

    await pool.query(
      "INSERT INTO accounts (account_key, provider, status, enabled) VALUES ($1, 'doubao', 'healthy', true)",
      [`monitor_account_${suffix}`],
    );
    await pool.query(
      `INSERT INTO service_account_bindings (tenant_id, provider, account_key, external_id)
       VALUES ($1, 'doubao', $2, 'doubao-main')`,
      [tenantId, `monitor_account_${suffix}`],
    );

    const plan = await createMonitorPlan(pool, {
      tenantId,
      projectId,
      now: new Date("2026-09-16T00:00:00Z"),
      input: {
        name: "每日 09:00",
        cadence: "daily",
        time_zone: "Asia/Shanghai",
        local_time: "09:00",
        accounts: ["doubao-main"],
      },
    });
    assert.equal(new Date(plan.next_run_at).toISOString(), "2026-09-16T01:00:00.000Z");

    const dueAt = new Date("2026-09-16T01:05:00Z");
    const first = await materializeDueMonitorExecutions(pool, { now: dueAt });
    assert.equal(first.length, 1);
    assert.equal(Number(first[0].plan_id), plan.id);
    assert.equal(new Date(first[0].scheduled_for).toISOString(), "2026-09-16T01:00:00.000Z");

    const second = await materializeDueMonitorExecutions(pool, { now: dueAt });
    assert.equal(second.length, 0);

    const executions = await listMonitorExecutions(pool, tenantId, plan.id, 10);
    assert.equal(executions.length, 1);
    assert.equal(executions[0].status, "pending");

    const { rows } = await pool.query("SELECT next_run_at FROM service_monitor_plans WHERE id = $1", [plan.id]);
    assert.equal(new Date(rows[0].next_run_at).toISOString(), "2026-09-17T01:00:00.000Z");
  } finally {
    if (tenantId) await pool.query("DELETE FROM service_tenants WHERE id = $1", [tenantId]).catch(() => undefined);
    if (projectId) await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.end();
  }
});
