import "dotenv/config";

import { createPool, isDatabaseConfigured } from "../src/db/pool.js";
import { closeRedis } from "../src/queue/connection.js";
import { collectSloSnapshot, evaluateSloSnapshot, sloConfig } from "../src/system/slo.js";

if (!isDatabaseConfigured()) {
  console.error("DATABASE_URL is not configured");
  process.exit(1);
}

const pool = createPool();
try {
  const config = sloConfig();
  const snapshot = await collectSloSnapshot(pool, config);
  const alerts = evaluateSloSnapshot(snapshot, config);
  const result = {
    status: alerts.length ? "degraded" : "ok",
    config,
    snapshot,
    alerts,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (alerts.some((item) => item.severity === "critical")) process.exitCode = 2;
  else if (alerts.length) process.exitCode = 1;
} finally {
  await pool.end().catch(() => undefined);
  await closeRedis().catch(() => undefined);
}
