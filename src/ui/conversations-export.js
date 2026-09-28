import { escapeHtml, num, dateTime, statusLabel, providerLabel } from "./format.js";

/**
 * 对话档案的批量导出。
 *
 * 三种格式各有明确用途，不是同一份数据的三个后缀：
 *   json  给后续处理（再统计、喂给模型、对比差异）
 *   csv   给 Excel 核对金额与计数
 *   html  给人读，也给自己归档 —— 断网可开、可直接转发
 *
 * CSV 必须处理 BOM 和引号：中文 Excel 不带 BOM 会按 GBK 解析成乱码，
 * 这是导出中文数据最常见的投诉来源。
 */

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return `"${text.replaceAll('"', '""').replace(/\r?\n/g, " ")}"`;
}

export function conversationsCsv(rows, meta = {}) {
  const header = [
    "local_run_id",
    "batch_id",
    "provider",
    "status",
    "prompt",
    "answer",
    "answer_chars",
    "answer_truncated",
    "captured_citation_count",
    "expected_citation_count",
    "citation_domains",
    "brand_mentioned",
    "error_code",
    "started_at",
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.local_run_id,
        row.sampling_batch_id,
        row.provider,
        row.status,
        row.prompt,
        row.answer,
        row.answer_chars,
        row.answer_truncated,
        row.captured_citation_count,
        row.expected_citation_count,
        (row.cite_domains ?? []).join(" "),
        row.brand_mentioned,
        row.error_code,
        row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  // BOM 必须在最前，否则 Excel 会用本地编码猜，中文直接乱码。
  return `﻿${lines.join("\r\n")}\r\n`;
}

export function conversationsJson(rows, meta = {}) {
  return JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      generator: "OneGl 对话档案导出",
      filters: meta.filters ?? {},
      counts: {
        total: rows.length,
        with_answer: rows.filter((r) => r.answer_chars > 0).length,
        citations: rows.reduce((sum, r) => sum + (r.captured_citation_count ?? 0), 0),
      },
      conversations: rows.map((row) => ({
        run_id: row.local_run_id,
        batch_id: row.sampling_batch_id,
        provider: row.provider,
        status: row.status,
        prompt: row.prompt,
        answer: row.answer,
        answer_chars: row.answer_chars,
        answer_truncated: row.answer_truncated,
        answer_completion: row.answer_completion,
        citations: row.captured_citation_count,
        expected_citations: row.expected_citation_count,
        citation_domains: row.cite_domains ?? [],
        brand_mentioned: row.brand_mentioned,
        error_code: row.error_code,
        error_message: row.error_message,
        started_at: row.started_at,
        finished_at: row.finished_at,
      })),
    },
    null,
    2,
  );
}

/**
 * 自包含 HTML 档案：不引用任何外部资源，双击即可打开。
 * 这一点是刻意的 —— 归档件半年后打开时，CDN 样式可能早失效了。
 */
export function conversationsHtml(rows, meta = {}) {
  const filters = meta.filters ?? {};
  const filterText = Object.entries(filters)
    .filter(([, v]) => v !== "" && v != null)
    .map(([k, v]) => `${k}=${escapeHtml(v)}`)
    .join("  ·  ");

  const withAnswer = rows.filter((r) => r.answer_chars > 0);
  const citations = rows.reduce((sum, r) => sum + (r.captured_citation_count ?? 0), 0);

  const cards = rows
    .map(
      (row) => `<section class="card">
  <header>
    <span class="tag ${row.status === "success" ? "ok" : row.status === "failed" ? "bad" : "warn"}">${escapeHtml(statusLabel(row.status))}</span>
    <span class="tag pv">${escapeHtml(providerLabel(row.provider))}</span>
    <code>${escapeHtml(row.local_run_id)}</code>
    <span class="meta">批次 #${escapeHtml(row.sampling_batch_id)} · ${escapeHtml(dateTime(row.started_at))}</span>
  </header>
  <div class="lbl">问题</div>
  <p class="q">${escapeHtml(row.prompt)}</p>
  <div class="lbl">AI 回答${row.answer_truncated ? ' <span class="warnmark">（被截断）</span>' : ""}</div>
  ${
    row.answer
      ? `<pre class="a">${escapeHtml(row.answer)}</pre>`
      : `<p class="none">（未抓到回答）${row.error_code ? ` · ${escapeHtml(row.error_code)}` : ""}</p>`
  }
  <footer>
    <span>引用 ${num(row.captured_citation_count ?? 0)}</span>
    <span>来源域名：${(row.cite_domains ?? []).map((d) => escapeHtml(d)).join("、") || "—"}</span>
  </footer>
</section>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OneGl 对话档案${filters.batch ? ` · 批次 ${escapeHtml(filters.batch)}` : ""}</title>
<style>
  :root{--ink:#382B23;--muted:#766153;--faint:#A18A78;--line:#E6D5C4;--bg:#F7F0E7;--surface:#FFFDFC;--surface-2:#FBF4EC;--accent:#B55B34;--ok:#667E4D;--warn:#BF852F;--bad:#B64E3E}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  .wrap{max-width:980px;margin:0 auto;padding:30px 18px 70px}
  h1{font-size:23px;margin:0 0 6px}
  .sub{color:var(--muted);font-size:13px;margin-bottom:20px}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:18px 0 26px}
  .stat{background:var(--surface);border:1px solid var(--line);border-radius:9px;padding:12px 14px}
  .stat .k{color:var(--muted);font-size:11.5px}
  .stat .v{font-size:20px;font-weight:650}
  .card{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:15px 17px;margin-bottom:13px}
  .card header{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:11px}
  .card code{font-size:11.5px;color:var(--faint)}
  .card .meta{font-size:11.5px;color:var(--faint);margin-left:auto}
  .tag{display:inline-block;padding:1px 8px;border-radius:5px;font-size:11.5px;background:var(--surface-2);border:1px solid var(--line);color:var(--muted)}
  .tag.ok{color:var(--ok)} .tag.warn{color:var(--warn)} .tag.bad{color:var(--bad)} .tag.pv{color:var(--accent)}
  .lbl{font-size:11px;font-weight:700;letter-spacing:.04em;color:var(--faint);margin:12px 0 5px;text-transform:uppercase}
  .q{margin:0;padding:8px 11px;background:var(--surface-2);border-left:2px solid var(--accent);border-radius:0 6px 6px 0;font-weight:550}
  .a{margin:0;white-space:pre-wrap;word-break:break-word;line-height:1.85;font:inherit;background:var(--surface-2);border:1px solid var(--line);border-radius:8px;padding:12px 14px;max-height:34rem;overflow:auto}
  .none{color:var(--faint);margin:0}
  .warnmark{color:var(--warn);font-weight:400;letter-spacing:0}
  .card footer{display:flex;gap:16px;flex-wrap:wrap;margin-top:12px;padding-top:10px;border-top:1px solid var(--line);font-size:11.5px;color:var(--muted)}
  .foot{margin-top:34px;padding-top:14px;border-top:1px solid var(--line);color:var(--faint);font-size:12px}
</style>
</head>
<body>
<div class="wrap">
  <h1>OneGl 对话档案</h1>
  <div class="sub">导出时间 ${escapeHtml(dateTime(new Date()))}${filterText ? ` ｜ 筛选：${filterText}` : ""}</div>
  <div class="cards">
    <div class="stat"><div class="k">对话总数</div><div class="v">${num(rows.length)}</div></div>
    <div class="stat"><div class="k">含回答</div><div class="v">${num(withAnswer.length)}</div></div>
    <div class="stat"><div class="k">引用合计</div><div class="v">${num(citations)}</div></div>
    <div class="stat"><div class="k">平台</div><div class="v">${num(new Set(rows.map((r) => r.provider)).size)}</div></div>
  </div>
${cards}
  <div class="foot">
    数据来源 OneGl PostgreSQL 实测记录。回答正文按原文呈现，未做 markdown 渲染；标记「被截断」的条目不应用于结论统计。
  </div>
</div>
</body>
</html>`;
}
