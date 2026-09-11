import { escapeHtml } from "./format.js";
import { STYLE } from "./style.js";

const NAV = [
  ["/", "总览", "home"],
  ["/batches", "抽样批次", "batches"],
  ["/runs", "运行记录", "runs"],
  ["/sources", "引用来源", "sources"],
  ["/projects", "项目配置", "projects"],
  ["/accounts", "账号状态", "accounts"],
];

function navLink(href, label, isActive) {
  return `<a href="${href}"${isActive ? ' class="active"' : ""}>${escapeHtml(label)}</a>`;
}

export function layout({ title, active = "", body, dbState = "" }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} · OneGl</title>
<style>${STYLE}</style>
</head>
<body>
<header class="topbar">
  <div class="brand">OneGl<small>豆包引用情报</small></div>
  <nav class="nav">${NAV.map(([href, label, key]) => navLink(href, label, active === key)).join("")}</nav>
  <div class="spacer"></div>
  <div class="db-state">${dbState}</div>
</header>
<main>${body}</main>
<footer>
  界面支持新建项目、人工录入关键词池、启用/禁用/删除关键词，以及从本项目关键词池创建抽样批次。
  向豆包真实提问耗时较长，仍通过命令行执行：<code>npm run batch:run -- --batch &lt;批次ID&gt;</code>
</footer>
</body></html>`;
}

export function metric({ label, value, hint = "", tone = "" }) {
  return `<div class="metric ${tone}">
  <div class="label">${escapeHtml(label)}</div>
  <div class="value">${escapeHtml(value)}</div>
  ${hint ? `<div class="hint">${escapeHtml(hint)}</div>` : ""}
</div>`;
}

export function metricGrid(cards) {
  return `<div class="grid">${cards.join("")}</div>`;
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

export function panel(title, { hint = "", body, actions = "" } = {}) {
  return `<section class="panel">
  <div class="panel-head"><strong>${escapeHtml(title)}</strong>${hint ? `<span>${escapeHtml(hint)}</span>` : ""}${actions}</div>
  <div class="panel-body">${body}</div>
</section>`;
}

export function dataTable({ columns, rows, empty = "暂无数据", rowKey = null }) {
  if (!rows.length) {
    return `<div class="empty">${escapeHtml(empty)}</div>`;
  }

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
      return `<tr${key}>${cells}</tr>`;
    })
    .join("");

  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export function notice(text, tone = "") {
  return `<div class="notice ${tone}">${text}</div>`;
}

export function kvList(rows) {
  const items = rows
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

export function breadcrumb(items) {
  return items.length ? `<p class="hint">${items.join(" / ")}</p>` : "";
}

export function runLink(localRunId, text = null) {
  return `<a href="/runs/${encodeURIComponent(localRunId)}">${escapeHtml(text ?? localRunId)}</a>`;
}
