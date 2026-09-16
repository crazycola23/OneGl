import "dotenv/config";

import { createPool, isDatabaseConfigured } from "../src/db/pool.js";
import { closeRedis } from "../src/queue/connection.js";
import { readinessReport, staticSafetyReport } from "../src/system/readiness.js";

function parseArgs(argv) {
  const args = { role: "api", staticOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--static") args.staticOnly = true;
    else if (token === "--role") {
      const next = argv[index + 1];
      if (!next) throw new Error("--role requires api, worker, webhook, or monitor");
      args.role = next;
      index += 1;
    } else if (token.startsWith("--role=")) args.role = token.slice(7);
    else throw new Error(`unknown argument: ${token}`);
  }
  if (!new Set(["api", "worker", "webhook", "monitor"]).has(args.role)) {
    throw new Error("--role must be api, worker, webhook, or monitor");
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
let pool = null;
try {
  const report = args.staticOnly
    ? staticSafetyReport({ role: args.role })
    : await readinessReport({
        role: args.role,
        pool: isDatabaseConfigured() ? (pool = createPool()) : null,
      });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ready) process.exitCode = 1;
} finally {
  if (pool) await pool.end().catch(() => undefined);
  await closeRedis().catch(() => undefined);
}
