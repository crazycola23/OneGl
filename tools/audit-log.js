import "dotenv/config";

import { createPool, isDatabaseConfigured } from "../src/db/pool.js";

function parseArgs(argv) {
  const out = { limit: 100, tenantId: null, status: null, errorOnly: false, hours: 24 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--limit") out.limit = Number(argv[++i]);
    else if (arg === "--tenant-id") out.tenantId = Number(argv[++i]);
    else if (arg === "--status") out.status = Number(argv[++i]);
    else if (arg === "--errors") out.errorOnly = true;
    else if (arg === "--hours") out.hours = Number(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(out.limit) || out.limit < 1 || out.limit > 1000) throw new Error("--limit must be 1..1000");
  if (out.tenantId !== null && (!Number.isInteger(out.tenantId) || out.tenantId <= 0)) throw new Error("--tenant-id must be positive");
  if (out.status !== null && (!Number.isInteger(out.status) || out.status < 100 || out.status > 599)) throw new Error("--status must be 100..599");
  if (!Number.isFinite(out.hours) || out.hours <= 0 || out.hours > 24 * 365) throw new Error("--hours must be > 0 and <= 8760");
  return out;
}

async function main() {
  if (!isDatabaseConfigured()) throw new Error("DATABASE_URL is not configured");
  const args = parseArgs(process.argv.slice(2));
  const pool = createPool();
  try {
    const { rows } = await pool.query(
      `SELECT a.request_id, a.created_at, a.auth_kind, a.tenant_id, t.slug AS tenant_slug,
              a.client_id, c.name AS client_name, a.method, a.path, a.route_key,
              a.status, a.duration_ms, a.error_code, a.idempotency_replayed, a.rate_limited
         FROM service_api_audit_logs a
         LEFT JOIN service_tenants t ON t.id = a.tenant_id
         LEFT JOIN service_api_clients c ON c.id = a.client_id
        WHERE a.created_at >= now() - ($1 * interval '1 hour')
          AND ($2::bigint IS NULL OR a.tenant_id = $2)
          AND ($3::integer IS NULL OR a.status = $3)
          AND ($4::boolean = false OR a.status >= 400)
        ORDER BY a.id DESC
        LIMIT $5`,
      [args.hours, args.tenantId, args.status, args.errorOnly, args.limit],
    );
    process.stdout.write(`${JSON.stringify({ filters: args, data: rows }, null, 2)}\n`);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
