import "dotenv/config";
import { safetyConfig } from "../src/accounts/safety.js";
import { loadConfig } from "../src/config.js";
import { auditOperationRisk } from "../src/operation-risk.js";

export { auditOperationRisk } from "../src/operation-risk.js";

function print(report) {
  console.log(`\nOneGl operation risk: ${report.risk.toUpperCase()}`);
  console.table([report.config]);
  if (!report.findings.length) {
    console.log("No elevated settings detected by the local heuristic audit.");
    return;
  }
  console.table(
    report.findings.map((item) => ({
      风险: item.level,
      范围: item.area,
      发现: item.message,
      建议: item.recommendation,
    })),
  );
  console.log(
    "\nThis is a local operational-risk heuristic, not a statement of Doubao's unpublished detection rules or an assurance that automation is permitted.",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = auditOperationRisk({ app: loadConfig(), safety: safetyConfig() });
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else print(report);
}
