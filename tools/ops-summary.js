import "dotenv/config";

import { createPool, isDatabaseConfigured } from "../src/db/pool.js";

function parseArgs(argv) {
  const out = { hours: 24, tenantId: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--hours") out.hours = Number(argv[++i]);
    else if (arg === "--tenant-id") out.tenantId = Number(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(out.hours) || out.hours <= 0 || out.hours > 24 * 365) throw new Error("--hours must be > 0 and <= 8760");
  if (out.tenantId !== null && (!Number.isInteger(out.tenantId) || out.tenantId <= 0)) throw new Error("--tenant-id must be positive");
  return out;
}

function numericRows(rows, key = "n") {
  return rows.map((row) => ({ ...row, [key]: Number(row[key]) }));
}

async function main() {
  if (!isDatabaseConfigured()) throw new Error("DATABASE_URL is not configured");
  const args = parseArgs(process.argv.slice(2));
  const pool = createPool();
  try {
    const [api, routes, errors, executions, accounts, webhookEvents, webhookDeliveries, runs] = await Promise.all([
      pool.query(
        `SELECT count(*)::bigint AS requests,
                count(*) FILTER (WHERE status >= 400)::bigint AS errors,
                count(*) FILTER (WHERE rate_limited)::bigint AS rate_limited,
                round(avg(duration_ms)::numeric, 1) AS avg_duration_ms,
                round(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::numeric, 1) AS p95_duration_ms
           FROM service_api_audit_logs
          WHERE created_at >= now() - ($1 * interval '1 hour')
            AND ($2::bigint IS NULL OR tenant_id = $2)`,
        [args.hours, args.tenantId],
      ),
      pool.query(
        `SELECT method, route_key, count(*)::bigint AS n,
                round(avg(duration_ms)::numeric, 1) AS avg_duration_ms,
                round(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::numeric, 1) AS p95_duration_ms
           FROM service_api_audit_logs
          WHERE created_at >= now() - ($1 * interval '1 hour')
            AND ($2::bigint IS NULL OR tenant_id = $2)
          GROUP BY method, route_key
          ORDER BY n DESC, method, route_key
          LIMIT 20`,
        [args.hours, args.tenantId],
      ),
      pool.query(
        `SELECT COALESCE(error_code, 'http_' || status::text) AS error_code, status, count(*)::bigint AS n
           FROM service_api_audit_logs
          WHERE created_at >= now() - ($1 * interval '1 hour')
            AND status >= 400
            AND ($2::bigint IS NULL OR tenant_id = $2)
          GROUP BY COALESCE(error_code, 'http_' || status::text), status
          ORDER BY n DESC, error_code
          LIMIT 20`,
        [args.hours, args.tenantId],
      ),
      pool.query(
        `SELECT COALESCE(b.status, 'pending') AS status, count(*)::bigint AS n,
                round(avg(EXTRACT(EPOCH FROM (b.finished_at - b.started_at)) * 1000)
                  FILTER (WHERE b.started_at IS NOT NULL AND b.finished_at IS NOT NULL)::numeric, 1) AS avg_duration_ms
           FROM service_task_executions e
           LEFT JOIN sampling_batches b ON b.id = e.batch_id
          WHERE e.created_at >= now() - ($1 * interval '1 hour')
            AND ($2::bigint IS NULL OR e.tenant_id = $2)
          GROUP BY COALESCE(b.status, 'pending')
          ORDER BY status`,
        [args.hours, args.tenantId],
      ),
      pool.query(
        `SELECT a.status, count(*)::bigint AS n
           FROM service_account_bindings sab
           JOIN accounts a ON a.provider = sab.provider AND a.account_key = sab.account_key
          WHERE ($1::bigint IS NULL OR sab.tenant_id = $1)
          GROUP BY a.status ORDER BY a.status`,
        [args.tenantId],
      ),
      pool.query(
        `SELECT status, count(*)::bigint AS n
           FROM service_webhook_events
          WHERE created_at >= now() - ($1 * interval '1 hour')
            AND ($2::bigint IS NULL OR tenant_id = $2)
          GROUP BY status ORDER BY status`,
        [args.hours, args.tenantId],
      ),
      pool.query(
        `SELECT d.status, count(*)::bigint AS n
           FROM service_webhook_deliveries d
           JOIN service_webhook_events e ON e.id = d.event_id
          WHERE d.attempted_at >= now() - ($1 * interval '1 hour')
            AND ($2::bigint IS NULL OR e.tenant_id = $2)
          GROUP BY d.status ORDER BY d.status`,
        [args.hours, args.tenantId],
      ),
      pool.query(
        `SELECT COALESCE(r.status, 'pending') AS status, count(*)::bigint AS n
           FROM service_task_results sr
           JOIN service_task_executions e ON e.id = sr.execution_id
           LEFT JOIN runs r ON r.local_run_id = sr.run_id
          WHERE sr.created_at >= now() - ($1 * interval '1 hour')
            AND ($2::bigint IS NULL OR e.tenant_id = $2)
          GROUP BY COALESCE(r.status, 'pending') ORDER BY status`,
        [args.hours, args.tenantId],
      ),
    ]);

    const apiRow = api.rows[0] ?? {};
    const result = {
      window: { hours: args.hours, tenant_id: args.tenantId },
      api: {
        requests: Number(apiRow.requests ?? 0),
        errors: Number(apiRow.errors ?? 0),
        rate_limited: Number(apiRow.rate_limited ?? 0),
        avg_duration_ms: apiRow.avg_duration_ms == null ? null : Number(apiRow.avg_duration_ms),
        p95_duration_ms: apiRow.p95_duration_ms == null ? null : Number(apiRow.p95_duration_ms),
        top_routes: numericRows(routes.rows),
        top_errors: numericRows(errors.rows),
      },
      executions: numericRows(executions.rows),
      accounts: numericRows(accounts.rows),
      webhooks: {
        events: numericRows(webhookEvents.rows),
        deliveries: numericRows(webhookDeliveries.rows),
      },
      results: numericRows(runs.rows),
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
