import { safetyConfig } from "../accounts/safety.js";
import { summarizeOperationRisk } from "../operation-risk.js";
import { dateTime, escapeHtml, num } from "./format.js";

const LEVEL_LABEL = Object.freeze({ low: "低", medium: "中", high: "高" });
const LEVEL_TONE = Object.freeze({ low: "ok", medium: "warn", high: "bad" });

function accountRows(system) {
  const groups = system?.accounts ?? {};
  const seen = new Set();
  const rows = [];
  for (const key of ["healthy", "auto_waiting", "manual_attention", "disabled"]) {
    for (const account of groups[key] ?? []) {
      const id = `${account.provider ?? "doubao"}:${account.account_key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push(account);
    }
  }
  return rows;
}

function appConfigFromEnv() {
  return {
    browser: process.env.ONEGL_BROWSER ?? "camoufox",
    headless: String(process.env.ONEGL_HEADLESS ?? "false").toLowerCase() === "true",
    networkEvidenceEnabled:
      String(process.env.ONEGL_NETWORK_EVIDENCE ?? "false").toLowerCase() === "true",
  };
}

function badge(level, accountKey = null) {
  const tone = LEVEL_TONE[level] ?? "muted";
  const marker = accountKey == null ? "" : ` data-risk-account="${escapeHtml(accountKey)}" data-risk-account-level="${escapeHtml(level)}"`;
  return `<span class="badge ${tone}"${marker}>${LEVEL_LABEL[level] ?? level}</span>`;
}

function statusText(account) {
  const map = {
    healthy: "正常",
    unknown: "未知",
    cooldown: "冷却中",
    paused: "已暂停",
    disabled: "已禁用",
    login_required: "需要登录",
    session_expired: "登录态失效",
    verification_required: "需要人工验证",
    access_restricted: "访问受限",
    rate_limited: "频率限制",
  };
  return map[account.status] ?? account.status ?? "未知";
}

function nextAllowedText(item) {
  if (!item.account.enabled) return "已禁用";
  if (["login_required", "session_expired", "verification_required", "access_restricted", "paused"].includes(item.account.status)) {
    return "人工处理后";
  }
  return item.nextAllowedAt ? dateTime(item.nextAllowedAt) : "现在";
}

function accountTable(report, safety) {
  if (!report.accounts.length) {
    return `<div class="empty"><div class="empty-title">还没有账号风险数据。</div></div>`;
  }
  const rows = report.accounts
    .map((item) => {
      const account = item.account;
      const rawKey = String(account.account_key ?? "");
      const key = escapeHtml(rawKey);
      const reasons = item.reasons.length ? item.reasons.join("；") : "当前未发现明显运行风险信号";
      return `<tr>
  <td><code>${key}</code></td>
  <td>${badge(item.level, rawKey)}</td>
  <td>${escapeHtml(statusText(account))}</td>
  <td class="num"><span data-risk-hourly="${key}">—</span> / ${num(safety.accountHourlyLimit)}</td>
  <td class="num">${num(account.runs_today ?? 0)} / ${num(safety.accountDailyLimit)}</td>
  <td class="nowrap" data-risk-next="${key}">${escapeHtml(nextAllowedText(item))}</td>
  <td>${escapeHtml(reasons)}</td>
</tr>`;
    })
    .join("");
  return `<table>
<thead><tr><th>账号</th><th>风险</th><th>状态</th><th class="num">最近1小时 / 上限</th><th class="num">今日 / 上限</th><th>下一次可运行</th><th>原因</th></tr></thead>
<tbody>${rows}</tbody></table>`;
}

function controlScript({ activeBatchIds, hourlyLimit }) {
  const batchJson = JSON.stringify(activeBatchIds ?? []).replace(/</g, "\\u003c");
  return `<script>
(function(){
  const activeBatches = ${batchJson};
  const hourlyLimit = ${Number(hourlyLimit) || 20};
  const stopButton = document.getElementById('risk-stop-all');
  const levelRank = { low: 1, medium: 2, high: 3 };
  const levelLabel = { low: '低', medium: '中', high: '高' };
  const levelTone = { low: 'ok', medium: 'warn', high: 'bad' };

  function promoteBadge(node, targetLevel) {
    if (!node) return;
    const current = node.getAttribute('data-risk-account-level') || 'low';
    if ((levelRank[targetLevel] || 0) <= (levelRank[current] || 0)) return;
    node.classList.remove('ok', 'warn', 'bad');
    node.classList.add(levelTone[targetLevel]);
    node.textContent = levelLabel[targetLevel];
    node.setAttribute('data-risk-account-level', targetLevel);
  }

  function promoteOverall(targetLevel) {
    const node = document.querySelector('[data-risk-overall]');
    if (!node) return;
    const current = node.getAttribute('data-risk-overall') || 'low';
    if ((levelRank[targetLevel] || 0) <= (levelRank[current] || 0)) return;
    node.textContent = levelLabel[targetLevel];
    node.setAttribute('data-risk-overall', targetLevel);
  }

  if (stopButton) {
    stopButton.addEventListener('click', async function(){
      if (!activeBatches.length) return;
      const message = '确认停止当前全部采集批次？排队任务会取消，已经执行中的单条任务会安全结束。';
      if (!window.confirm(message)) return;
      stopButton.disabled = true;
      stopButton.textContent = '正在停止…';
      try {
        for (const batchId of activeBatches) {
          await fetch('/batches/' + encodeURIComponent(batchId) + '/stop', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
            body: ''
          });
        }
      } finally {
        window.location.reload();
      }
    });
  }

  // Hourly usage is derived from the existing read-only runs API. This keeps the dashboard
  // observational: no extra provider request is made just to calculate risk.
  fetch('/api/runs', { cache: 'no-store' })
    .then(function(response){ return response.ok ? response.json() : []; })
    .then(function(runs){
      if (!Array.isArray(runs)) return;
      const now = Date.now();
      const cutoff = now - 60 * 60 * 1000;
      const byAccount = new Map();
      for (const run of runs) {
        const key = run.account_key || run.accountKey;
        const at = Date.parse(run.started_at || run.startedAt || '');
        if (!key || Number.isNaN(at) || at < cutoff) continue;
        const list = byAccount.get(key) || [];
        list.push(at);
        byAccount.set(key, list);
      }
      for (const [key, times] of byAccount.entries()) {
        times.sort(function(a,b){ return a-b; });
        const selectorKey = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(key) : key.replace(/["\\]/g, '\\$&');
        const countNode = document.querySelector('[data-risk-hourly="' + selectorKey + '"]');
        if (countNode) countNode.textContent = String(times.length);
        const riskNode = document.querySelector('[data-risk-account="' + selectorKey + '"]');
        if (times.length >= hourlyLimit) {
          promoteBadge(riskNode, 'high');
          promoteOverall('high');
          const next = new Date(times[0] + 60 * 60 * 1000 + 1000);
          const nextNode = document.querySelector('[data-risk-next="' + selectorKey + '"]');
          if (nextNode) nextNode.textContent = next.toLocaleString('zh-CN');
        } else if (times.length / hourlyLimit >= 0.75) {
          promoteBadge(riskNode, 'medium');
          promoteOverall('medium');
        }
      }
      document.querySelectorAll('[data-risk-hourly]').forEach(function(node){
        if (node.textContent === '—') node.textContent = '0';
      });
    })
    .catch(function(){});
})();
</script>`;
}

/**
 * Expanded risk control card shown on the homepage and accounts page.
 * It is deliberately operational rather than predictive: the labels describe OneGl's
 * current pacing/configuration and explicit platform signals, not an unpublished Doubao score.
 */
export function riskDashboardPanel(system, { active = "" } = {}) {
  if (!system || !["home", "accounts"].includes(active)) return "";
  const safety = safetyConfig();
  const accounts = accountRows(system);
  const report = summarizeOperationRisk(accounts, {
    app: appConfigFromEnv(),
    safety,
  });
  const activeBatchIds = (system.activeBatches ?? []).map((batch) => Number(batch.id)).filter(Number.isFinite);
  const findingSummary = report.configAudit.findings.length
    ? report.configAudit.findings.slice(0, 3).map((item) => item.message).join("；")
    : "当前配置未触发高于低风险的本地启发式规则";
  const panelClass = report.risk === "high" ? "card tone-blocked" : "card";

  return `<section class="${panelClass}" id="operation-risk-panel">
  <div class="card-head">
    <strong>运行风险与安全控制</strong>
    <span>本地运行风险启发式，不代表豆包内部风控分数</span>
    <div class="card-actions">
      <button id="risk-stop-all" class="ghost danger" type="button"${activeBatchIds.length ? "" : " disabled"}>一键暂停当前全部采集</button>
      <a class="linkbtn" href="/accounts">账号详情</a>
    </div>
  </div>
  <div class="card-body">
    <div class="stats">
      <div class="stat ${LEVEL_TONE[report.risk]}"><div class="label">当前总体风险</div><div class="value" data-risk-overall="${escapeHtml(report.risk)}">${escapeHtml(LEVEL_LABEL[report.risk])}</div><div class="hint">配置风险 ${escapeHtml(LEVEL_LABEL[report.configRisk])} · 高风险账号 ${num(report.highRiskAccounts)}</div></div>
      <div class="stat"><div class="label">正在运行的批次</div><div class="value">${num(activeBatchIds.length)}</div><div class="hint">暂停按钮只操作 OneGl 本地队列，不处理验证码或绕过限制</div></div>
      <div class="stat"><div class="label">今日账号运行</div><div class="value">${num(report.totalRunsToday)}</div><div class="hint">单账号每日上限 ${num(safety.accountDailyLimit)}</div></div>
      <div class="stat"><div class="label">滚动小时上限</div><div class="value">${num(safety.accountHourlyLimit)}</div><div class="hint">页面打开后从现有 Runs 数据实时计算最近 1 小时用量</div></div>
    </div>
    <div class="notice ${LEVEL_TONE[report.risk] === "bad" ? "bad" : LEVEL_TONE[report.risk] === "warn" ? "warn" : ""}" style="margin:0 16px 16px">
      ${escapeHtml(findingSummary)}。若出现频率限制、人机验证或访问受限，系统应停止并等待人工处理，而不是继续重试。
    </div>
    <div style="overflow:auto">${accountTable(report, safety)}</div>
    <div class="hint" style="padding:12px 16px 16px;margin:0">“一键暂停当前全部采集”会停止当前 queued/running 批次；已在浏览器里执行的单条任务会安全结束，排队任务会取消。它不会更改已存在的 rate_limited / verification_required 等账号风险状态。</div>
  </div>
</section>${controlScript({ activeBatchIds, hourlyLimit: safety.accountHourlyLimit })}`;
}

/** Compact sidebar signal used on every page. */
export function sidebarRisk(system) {
  if (!system) return { level: "low", label: "低" };
  const report = summarizeOperationRisk(accountRows(system), {
    app: appConfigFromEnv(),
    safety: safetyConfig(),
  });
  return { level: report.risk, label: LEVEL_LABEL[report.risk] ?? report.risk };
}
