/**
 * Presentation helpers for the dashboard. Every operator-facing string is Chinese;
 * identifiers, error codes and database columns stay in their original form so they
 * remain greppable.
 */

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function num(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number.toLocaleString("zh-CN") : "0";
}

export function pct(numerator, denominator, digits = 1) {
  const top = Number(numerator ?? 0);
  const bottom = Number(denominator ?? 0);
  if (!bottom) return "—";
  return `${((top / bottom) * 100).toFixed(digits)}%`;
}

export function dateTime(value) {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function truncate(value, max = 80) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const STATUS_LABELS = {
  pending: "待执行",
  running: "执行中",
  success: "成功",
  partial: "部分成功",
  failed: "失败",
  completed: "已完成",
  aborted: "已中止",
};

const STATUS_TONES = {
  pending: "muted",
  running: "info",
  success: "ok",
  partial: "warn",
  failed: "bad",
  completed: "ok",
  aborted: "muted",
};

export function statusLabel(status) {
  return STATUS_LABELS[status] ?? status ?? "未知";
}

export function statusTone(status) {
  return STATUS_TONES[status] ?? "muted";
}

const ERROR_LABELS = {
  DOUBAO_LOGIN_REQUIRED: "豆包未登录，需要先执行 npm run auth",
  DOUBAO_SESSION_EXPIRED: "登录态已失效，请重新登录",
  DOUBAO_VERIFICATION_REQUIRED: "触发了人机验证，需要人工处理",
  DOUBAO_ACCESS_RESTRICTED: "账号被限制访问",
  DOUBAO_TIMEOUT: "等待回答超时",
  DOUBAO_SUBMISSION_FAILED: "提问未确认发送",
  ANSWER_NOT_FOUND: "未找到回答内容",
  CITATION_PARSE_FAILED: "引用数量与页面标注不一致",
  PAGE_CHANGED: "页面结构变化，无法确认输入框",
  RATE_LIMITED: "触发频率限制",
  NETWORK_ERROR: "网络异常",
  UNKNOWN_ERROR: "未知错误",
};

export function errorCodeLabel(code) {
  if (!code) return "—";
  return ERROR_LABELS[code] ?? code;
}

export function hasErrorCode(code) {
  return Boolean(code);
}

/** Explains a metric in one line, shown under the number. */
export const METRIC_HINTS = {
  validRuns: "状态为成功/部分成功，且确认从空会话开始",
  runMentionRate: "提及品牌的 Run ÷ 有效 Run",
  promptCoverage: "出现品牌的去重问题数 ÷ 全部去重问题数",
  trackedRate: "至少被引用过一次的监控文章 ÷ 全部监控文章",
  citations: "该批次全部可见引用条数",
  partial: "回答已抓到，但引用数量与页面标注不符",
};

export function sourceLabel(accountKey) {
  return accountKey ?? "未分配";
}
