import { classifyAccountState, safetyConfig } from "./accounts/safety.js";

const RISK_SCORE = Object.freeze({ low: 1, medium: 2, high: 3 });

export function severityScore(level) {
  return RISK_SCORE[level] ?? 0;
}

export function highestRisk(levels, fallback = "low") {
  return (levels ?? []).reduce(
    (current, level) => (severityScore(level) > severityScore(current) ? level : current),
    fallback,
  );
}

function finding(level, area, message, recommendation) {
  return { level, area, message, recommendation };
}

/**
 * Static/local configuration audit.
 *
 * This intentionally does not claim to know Doubao's unpublished detection thresholds.
 * It only identifies OneGl settings that make browser automation more bursty, harder to
 * supervise, or slower to stop after a platform warning signal.
 */
export function auditOperationRisk({ app = {}, safety = safetyConfig() } = {}) {
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

  return {
    risk: highestRisk(findings.map((item) => item.level)),
    config: {
      browser: app.browser ?? null,
      headless: app.headless === true,
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

/**
 * Live account risk/capacity view for the dashboard.
 *
 * The level is an operator heuristic, not a platform score. It deliberately treats explicit
 * rate-limit / verification / access-restriction signals as stronger than simple volume use.
 */
export function assessAccountRisk(account, { safety = safetyConfig(), now = new Date() } = {}) {
  if (!account) {
    return { level: "low", reasons: [], nextAllowedAt: null, availability: null };
  }

  const reasons = [];
  const levels = [];
  const status = account.status ?? "unknown";

  if (!account.enabled) {
    return {
      level: "low",
      reasons: ["账号已禁用，不会收到任务"],
      nextAllowedAt: null,
      availability: "disabled",
    };
  }

  if (["verification_required", "access_restricted", "rate_limited"].includes(status)) {
    levels.push("high");
    reasons.push(
      status === "verification_required"
        ? "平台要求人工验证"
        : status === "access_restricted"
          ? "平台报告访问受限"
          : "平台报告频率限制",
    );
  } else if (["login_required", "session_expired", "paused", "cooldown"].includes(status)) {
    levels.push("medium");
    reasons.push(
      status === "cooldown"
        ? "账号正在冷却"
        : status === "paused"
          ? "账号已人工暂停"
          : "登录态需要人工处理",
    );
  }

  const failures = Number(account.consecutive_failures ?? 0);
  if (failures >= Number(safety.maxConsecutiveFailures ?? 3)) {
    levels.push("high");
    reasons.push(`连续失败 ${failures} 次`);
  } else if (failures >= 2) {
    levels.push("medium");
    reasons.push(`连续失败 ${failures} 次`);
  }

  const today = Number(account.runs_today ?? 0);
  const dailyLimit = Number(safety.accountDailyLimit ?? 0);
  if (dailyLimit > 0 && today >= dailyLimit) {
    levels.push("medium");
    reasons.push(`已达到每日运行上限 ${dailyLimit}`);
  } else if (dailyLimit > 0 && today / dailyLimit >= 0.8) {
    levels.push("medium");
    reasons.push(`今日额度已使用 ${Math.round((today / dailyLimit) * 100)}%`);
  }

  const hourly = Number(account.runs_last_hour ?? 0);
  const hourlyLimit = Number(safety.accountHourlyLimit ?? 0);
  if (hourlyLimit > 0 && hourly >= hourlyLimit) {
    levels.push("high");
    reasons.push(`已达到滚动 1 小时上限 ${hourlyLimit}`);
  } else if (hourlyLimit > 0 && hourly / hourlyLimit >= 0.75) {
    levels.push("medium");
    reasons.push(`最近 1 小时额度已使用 ${Math.round((hourly / hourlyLimit) * 100)}%`);
  }

  const verdict = classifyAccountState(account, { config: safety, now });
  return {
    level: highestRisk(levels),
    reasons,
    nextAllowedAt: verdict.retryAt ? verdict.retryAt.toISOString() : null,
    availability: verdict.kind,
  };
}

export function summarizeOperationRisk(
  accounts = [],
  { app = {}, safety = safetyConfig(), now = new Date() } = {},
) {
  const configAudit = auditOperationRisk({ app, safety });
  const accountReports = (accounts ?? []).map((account) => ({
    account,
    ...assessAccountRisk(account, { safety, now }),
  }));
  const liveRisk = highestRisk(accountReports.map((item) => item.level));
  const overallRisk = highestRisk([configAudit.risk, liveRisk]);
  return {
    risk: overallRisk,
    configRisk: configAudit.risk,
    configAudit,
    accounts: accountReports,
    highRiskAccounts: accountReports.filter((item) => item.level === "high").length,
    mediumRiskAccounts: accountReports.filter((item) => item.level === "medium").length,
    totalRunsToday: (accounts ?? []).reduce((sum, account) => sum + Number(account.runs_today ?? 0), 0),
    totalRunsLastHour: (accounts ?? []).reduce(
      (sum, account) => sum + Number(account.runs_last_hour ?? 0),
      0,
    ),
  };
}
