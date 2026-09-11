import { escapeHtml } from "./format.js";
import { STYLE } from "./style.js";
import {
  CONNECTION_STATES,
  WORKER_STATES,
  cachedSystemStatus,
} from "../system/status.js";

/**
 * 页面骨架与组件库。
 *
 * 布局：左侧常驻导航 + 右侧内容区。系统就绪状态收在侧栏底部，
 * 任何页面任何时刻都能扫到「现在能不能跑」。
 */

const NAV = [
  { group: "工作", items: [
    ["/", "总览", "home"],
    ["/projects", "项目", "projects"],
    ["/batches", "批次", "batches"],
    ["/runs", "运行记录", "runs"],
  ]},
  { group: "观测", items: [
    ["/sources", "引用来源", "sources"],
    ["/accounts", "账号", "accounts"],
    ["/system", "系统", "system"],
  ]},
];

function navHtml(active) {
  return NAV.map(
    ({ group, items }) => `<div class="nav-group">${escapeHtml(group)}</div>` +
      items
        .map(
          ([href, label, key]) =>
            `<a href="${href}"${active === key ? ' class="active"' : ""}><i class="pip"></i>${escapeHtml(label)}</a>`,
        )
        .join(""),
  ).join("");
}

/* ------------------------------------------------------------- 状态灯 */

export function lamp(tone = "muted") {
  return `<span class="lamp ${tone}"></span>`;
}

export function statusItem(label, value, tone = "muted") {
  return `<li>${lamp(tone)}${escapeHtml(label)}<b class="${tone}">${escapeHtml(value)}</b></li>`;
}

function connectionState(state) {
  if (state === CONNECTION_STATES.CONNECTED) return { text: "正常", tone: "ok" };
  if (state === CONNECTION_STATES.NOT_CONFIGURED) return { text: "未配置", tone: "muted" };
  return { text: "不可用", tone: "bad" };
}

function workerState(state) {
  if (state === WORKER_STATES.ONLINE) return { text: "在线", tone: "ok" };
  if (state === WORKER_STATES.DEGRADED) return { text: "心跳变慢", tone: "warn" };
  if (state === WORKER_STATES.OFFLINE) return { text: "离线", tone: "bad" };
  return { text: "未知", tone: "muted" };
}

export function connectionText(state) {
  return connectionState(state).text;
}

export function workerText(state) {
  return workerState(state).text;
}

/** 侧栏底部的就绪模块：结论 + 五个状态灯。 */
function deckStatus(system) {
  if (!system) return "";

  const db = connectionState(system.database?.state);
  const redis = connectionState(system.redis?.state);
  const worker = workerState(system.worker?.state);
  const accounts = system.accounts ?? { usable: 0, total: 0 };
  const running = (system.activeBatches ?? []).length;
  const ready = system.readiness?.ready;

  return `<div class="deck-status">
  <div class="verdict ${ready ? "ready" : "blocked"}">${lamp(ready ? "ok" : "bad")}${ready ? "可以开始" : "未就绪"}</div>
  <ul class="lamps">
    ${statusItem("DB", db.text, db.tone)}
    ${statusItem("Redis", redis.text, redis.tone)}
    ${statusItem("Worker", worker.text, worker.tone)}
    ${statusItem("可用账号", `${accounts.usable} / ${accounts.total}`, accounts.usable > 0 ? "ok" : accounts.total > 0 ? "warn" : "muted")}
    ${statusItem("运行中批次", String(running), running > 0 ? "info" : "muted")}
  </ul>
</div>`;
}

/* ---------------------------------------------------------------- 骨架 */

export function layout({ title, active = "", body, system = undefined }) {
  const status = system == null ? cachedSystemStatus() : system;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} · OneGl 操作台</title>
<style>${STYLE}</style>
</head>
<body>
<div class="deck">
  <aside class="side">
    <div class="brand"><span class="mark"></span><div><span class="name">OneGl</span><span class="sub">OPERATOR CONSOLE</span></div></div>
    <nav class="nav">${navHtml(active)}</nav>
    ${deckStatus(status)}
  </aside>
  <div class="main">
    <main>${body}</main>
    <footer>
      网页端可直接创建抽样批次并启动监测（BullMQ → Worker）；命令行 <code>npm run batch:run -- --batch &lt;ID&gt;</code> 保留为高级与故障排查方式。
      服务仅监听 <code>127.0.0.1</code>，无登录鉴权，请勿对外暴露。
    </footer>
  </div>
</div>
</body></html>`;
}

/** 页头：分区标签 + 标题 + 说明 + 右侧主动作。 */
export function pageHead({ kicker = "", title, sub = "", actions = "" }) {
  return `<div class="page-head">
  ${kicker ? `<div class="page-kicker">${kicker}</div>` : ""}
  <div class="page-title-row"><h1>${title}</h1>${actions ? `<div class="page-actions">${actions}</div>` : ""}</div>
  ${sub ? `<div class="page-sub">${sub}</div>` : ""}
</div>`;
}

/* ---------------------------------------------------------------- 组件 */

export function metric({ label, value, hint = "", tone = "" }) {
  return `<div class="stat ${tone}">
  <div class="label">${escapeHtml(label)}</div>
  <div class="value">${escapeHtml(value)}</div>
  ${hint ? `<div class="hint">${hint}</div>` : ""}
</div>`;
}

export function metricGrid(cards) {
  return `<div class="stats">${cards.join("")}</div>`;
}

export function badge(text, tone = "") {
  return `<span class="badge ${tone}">${escapeHtml(text)}</span>`;
}

export function bar(numerator, denominator, tone = "") {
  const top = Number(numerator ?? 0);
  const bottom = Number(denominator ?? 0);
  const width = bottom ? Math.min(100, Math.round((top / bottom) * 100)) : 0;
  return `<div class="bar ${tone}"><span style="width:${width}%"></span></div>`;
}

/** 批次进度：成功 / 失败 / 跳过 / 运行中画成一条，剩余为未执行。 */
export function stackedBar(segments, total) {
  const sum = Number(total ?? 0);
  if (!sum) return `<div class="bar"><span style="width:0%"></span></div>`;
  const parts = segments
    .filter((segment) => Number(segment.value) > 0)
    .map((segment) => {
      const width = (Number(segment.value) / sum) * 100;
      return `<i class="${segment.tone}" style="width:${width}%" title="${escapeHtml(`${segment.label} ${segment.value}`)}"></i>`;
    })
    .join("");
  return `<div class="bar stacked">${parts}</div>`;
}

export function panel(title, { hint = "", body, actions = "", tone = "" } = {}) {
  return `<section class="card ${tone ? `tone-${tone}` : ""}">
  <div class="card-head"><strong>${escapeHtml(title)}</strong>${hint ? `<span>${hint}</span>` : ""}${actions ? `<div class="card-actions">${actions}</div>` : ""}</div>
  <div class="card-body">${body}</div>
</section>`;
}

export function dataTable({ columns, rows, empty = "暂无数据", rowKey = null, rowTone = null }) {
  if (!rows.length) return emptyState(empty);

  const head = columns
    .map((column) => {
      const classes = [column.align === "right" ? "num" : "", column.nowrap ? "nowrap" : ""]
        .filter(Boolean)
        .join(" ");
      return `<th${classes ? ` class="${classes}"` : ""}>${escapeHtml(column.label)}</th>`;
    })
    .join("");

  const body = rows
    .map((row) => {
      const cells = columns
        .map((column) => {
          const classes = [column.align === "right" ? "num" : "", column.className ?? ""]
            .filter(Boolean)
            .join(" ");
          const value = column.render ? column.render(row) : escapeHtml(row[column.key] ?? "—");
          return `<td${classes ? ` class="${classes}"` : ""}>${value}</td>`;
        })
        .join("");
      const key = rowKey ? ` data-key="${escapeHtml(rowKey(row))}"` : "";
      const tone = rowTone ? rowTone(row) : "";
      return `<tr${key}${tone ? ` class="row-${tone}"` : ""}>${cells}</tr>`;
    })
    .join("");

  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** 空状态必须告诉操作者下一步做什么。 */
export function emptyState(message, { hint = "", action = "" } = {}) {
  return `<div class="empty">
  <div class="empty-title">${escapeHtml(message)}</div>
  ${hint ? `<div class="empty-hint">${hint}</div>` : ""}
  ${action ? `<div class="empty-action">${action}</div>` : ""}
</div>`;
}

export function notice(text, tone = "") {
  return `<div class="notice ${tone}">${text}</div>`;
}

export function kvList(rows) {
  const items = rows
    .filter(Boolean)
    .map(
      ([key, value]) =>
        `<dt>${escapeHtml(key)}</dt><dd>${value == null ? "—" : typeof value === "string" ? escapeHtml(value) : value}</dd>`,
    )
    .join("");
  return `<dl class="kv">${items}</dl>`;
}

export function cmd(command, label = "") {
  return `${label ? `<div class="hint">${escapeHtml(label)}</div>` : ""}<code class="cmd">${escapeHtml(command)}</code>`;
}

export function filters(items) {
  return `<div class="filters">${items
    .map(
      (item) =>
        `<a href="${escapeHtml(item.href)}"${item.active ? ' class="active"' : ""}>${escapeHtml(item.label)}${item.count == null ? "" : ` ${escapeHtml(String(item.count))}`}</a>`,
    )
    .join("")}</div>`;
}

export function runLink(localRunId, text = null) {
  return `<a class="mono" href="/runs/${encodeURIComponent(localRunId)}">${escapeHtml(text ?? localRunId)}</a>`;
}

/**
 * 按钮层级：primary（创建 / 开始监测，金色）、secondary（恢复 / 重试，描边）、
 * danger（停止 / 禁用 / 删除，红色描边，一律带确认）。
 */
export function formButton({
  action,
  label,
  tone = "primary",
  confirm = null,
  disabled = false,
  reason = "",
  method = "post",
  field = null,
}) {
  const klass = tone === "primary" ? "" : ` class="ghost${tone === "danger" ? " danger" : ""}"`;
  const onsubmit = confirm ? ` onsubmit="return confirm('${confirm.replace(/'/g, "\\'")}');"` : "";
  const attrs = disabled ? ` disabled title="${escapeHtml(reason)}"` : "";
  return `<form class="inline-form" method="${method}" action="${escapeHtml(action)}"${onsubmit}>
  ${field ?? ""}<button${klass} type="submit"${attrs}>${escapeHtml(label)}</button></form>`;
}
