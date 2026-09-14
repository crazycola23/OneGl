import "dotenv/config";
import { safetyConfig } from "../src/accounts/safety.js";
import { loadConfig } from "../src/config.js";

function severityScore(level) {
  return { low: 1, medium: 2, high: 3 }[level] ?? 0;
}

function finding(level, area, message, recommendation) {
  return { level, area, message, recommendation };
}

export function auditOperationRisk({ app = loadConfig(), safety = safetyConfig() } = {}) {
  const findings = [];

  if (app.browser === "camoufox") {
    findings.push(
      finding(
        "medium",
        "browser",
        "Camoufox is a non-standard browser stack. Even without behavior humanization, it can create product-compatibility or terms-of-service risk compared with a normal local browser.",
        "For routine authorised monitoring, prefer a normal visible Chromium/Firefox profile when it works reliably.",
      ),
    );
  }
  if (app.headless) {
    findings.push(
      finding(
        "medium",
        "browser",
        "Headless mode is enabled.",
        "Prefer a visible browser for account-bound monitoring and manual verification workflows.",
      ),
    );
  }

  if (safety.minDelayMs < 10_000) {
    findings.push(
      finding(
        "high",
        "cadence",
        `Minimum delay is only ${safety.minDelayMs} ms.`,
        "Use a substantially slower cadence; OneGl's conservative default is at least 15 seconds between jobs.",
      ),
    );
  } else if (safety.minDelayMs < 15_000) {
    findings.push(
      finding(
        "medium",
        "cadence",
        `Minimum delay is ${safety.minDelayMs} ms.`,
        "Consider 15 seconds or more for repeated account-bound browser interactions.",
      ),
    );
  }

  if (safety.accountParallelism > 1) {
    findings.push(
      finding(
        "high",
        "parallelism",
        `Account parallelism is ${safety.accountParallelism}.`,
        "Keep global account parallelism at 1 unless the platform explicitly permits the intended automation volume.",
      ),
    );
  }

  if (safety.accountHourlyLimit > 20) {
    findings.push(
      finding(
        "medium",
        "volume",
        `Hourly account limit is ${safety.accountHourlyLimit}.`,
        "Keep the hourly ceiling conservative and lower it further if any rate-limit signal appears.",
      ),
    );
  }

  if (safety.accountDailyLimit > 100) {
    findings.push(
      finding(
        "medium",
        "volume",
        `Daily account limit is ${safety.accountDailyLimit}.`,
        "Use only the volume needed for the experiment and stay within applicable product terms and published limits.",
      ),
    );
  }

  if (safety.rateLimitCooldownMinutes < 60) {
    findings.push(
      finding(
        "high",
        "backoff",
        `Rate-limit cooldown is only ${safety.rateLimitCooldownMinutes} minutes.`,
        "Treat an explicit rate-limit response as a strong stop signal; use a long cooldown and manual review if it repeats.",
      ),
    );
  }

  if (app.networkEvidenceEnabled) {
    findings.push(
      finding(
        "low",
        "network-evidence",
        "Network evidence capture is enabled. It is passive and does not add platform requests, but it increases the amount of product internals being observed and stored.",
        "Keep it opt-in, avoid credentials/session material, and validate the evidence schema after product changes.",
      ),
    );
  }

  const highest = findings.reduce(
    (current, item) => (severityScore(item.level) > severityScore(current) ? item.level : current),
    "low",
  );

  return {
    risk: highest,
    config: {
      browser: app.browser,
      headless: app.headless,
      minDelayMs: safety.minDelayMs,
      maxDelayMs: safety.maxDelayMs,
      minInterRunMs: safety.minInterRunMs,
      accountHourlyLimit: safety.accountHourlyLimit,
      accountDailyLimit: safety.accountDailyLimit,
      rateLimitCooldownMinutes: safety.rateLimitCooldownMinutes,
      accountParallelism: safety.accountParallelism,
      networkEvidenceEnabled: app.networkEvidenceEnabled === true,
    },
    findings,
  };
}

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
  const report = auditOperationRisk();
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else print(report);
}
