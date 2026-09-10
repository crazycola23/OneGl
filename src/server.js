import "dotenv/config";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import { RunStore } from "./store.js";

const config = loadConfig();
const store = new RunStore(config);

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function layout(title, body) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)} · OneGl</title>
<style>
:root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
body { margin: 0; background: #0b0d10; color: #e8eaed; }
a { color: #8ab4f8; text-decoration: none; }
nav { display:flex; gap:18px; padding:18px 28px; border-bottom:1px solid #262a31; position:sticky; top:0; background:#0b0d10ee; backdrop-filter: blur(12px); }
main { max-width: 1180px; margin: 0 auto; padding: 28px; }
.grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:14px; margin:18px 0 28px; }
.card { border:1px solid #2b3038; border-radius:14px; padding:16px; background:#12151a; }
.metric { font-size:30px; font-weight:700; margin-top:5px; }
table { width:100%; border-collapse:collapse; background:#12151a; border-radius:14px; overflow:hidden; }
th, td { text-align:left; padding:12px 14px; border-bottom:1px solid #262a31; vertical-align:top; }
th { color:#aeb4bd; font-weight:600; font-size:13px; }
.badge { display:inline-block; border:1px solid #3a414c; border-radius:999px; padding:3px 9px; font-size:12px; }
pre { white-space:pre-wrap; word-break:break-word; line-height:1.65; background:#12151a; border:1px solid #2b3038; border-radius:14px; padding:18px; }
.muted { color:#9aa0a6; }
.error { color:#ffb4ab; }
img.debug { max-width:100%; border:1px solid #2b3038; border-radius:12px; }
</style>
</head>
<body>
<nav><strong>OneGl MVP</strong><a href="/">Runs</a><a href="/sources">Sources</a></nav>
<main>${body}</main>
</body></html>`;
}

function send(res, status, content, type = "text/html; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(content);
}

async function overviewPage() {
  const runs = await store.listRuns();
  const sources = await store.aggregateSources();
  const counts = runs.reduce(
    (acc, run) => {
      acc[run.status] = (acc[run.status] || 0) + 1;
      return acc;
    },
    {},
  );
  const rows = runs
    .map(
      (run) => `<tr>
<td><a href="/runs/${esc(run.id)}">${esc(run.id)}</a></td>
<td>${esc(run.project)}</td>
<td><span class="badge">${esc(run.status)}</span></td>
<td>${(run.citations || []).length}${run.expectedCitationCount == null ? "" : ` / ${esc(run.expectedCitationCount)}`}</td>
<td>${esc(String(run.prompt || "").slice(0, 120))}</td>
<td>${esc(run.errorCode || "")}</td>
</tr>`,
    )
    .join("");

  return layout(
    "Runs",
    `<h1>Doubao Runs</h1>
<p class="muted">这是验证面，不做 GEO 打分。先确认 Prompt → Answer → Visible Citation 数据链是否真实可靠。</p>
<div class="grid">
<div class="card"><div class="muted">Total runs</div><div class="metric">${runs.length}</div></div>
<div class="card"><div class="muted">Success</div><div class="metric">${counts.success || 0}</div></div>
<div class="card"><div class="muted">Partial</div><div class="metric">${counts.partial || 0}</div></div>
<div class="card"><div class="muted">Visible citations</div><div class="metric">${sources.totalCitations}</div></div>
</div>
<table><thead><tr><th>Run</th><th>Project</th><th>Status</th><th>Citations</th><th>Prompt</th><th>Error</th></tr></thead><tbody>${rows}</tbody></table>`,
  );
}

async function runPage(runId) {
  const run = await store.readRun(runId);
  const citations = (run.citations || [])
    .map(
      (item) => `<tr>
<td>${esc(item.sourcePosition)}</td>
<td>${item.url ? `<a href="${esc(item.url)}" target="_blank" rel="noreferrer">${esc(item.title || item.domain || item.url)}</a>` : esc(item.title)}</td>
<td>${esc(item.domain)}</td>
<td>${esc(item.citationMarker)}</td>
<td>${esc(item.relationStatus)}</td>
<td>${esc(item.answerText)}</td>
</tr>`,
    )
    .join("");
  const error = run.errorCode
    ? `<div class="card error"><strong>${esc(run.errorCode)}</strong><br>${esc(run.errorMessage)}</div>`
    : "";
  return layout(
    run.id,
    `<p><a href="/">← Runs</a></p>
<h1>${esc(run.id)}</h1>
<div class="grid">
<div class="card"><div class="muted">Status</div><div>${esc(run.status)}</div></div>
<div class="card"><div class="muted">Project</div><div>${esc(run.project)}</div></div>
<div class="card"><div class="muted">Citation state</div><div>${esc(run.citationState)}</div></div>
<div class="card"><div class="muted">Current URL</div><div>${esc(run.currentUrl)}</div></div>
</div>
${error}
<h2>Prompt</h2><pre>${esc(run.prompt)}</pre>
<h2>Answer</h2><pre>${esc(run.answer || "")}</pre>
<h2>Visible citations</h2>
<p class="muted">Captured ${(run.citations || []).length}${run.expectedCitationCount == null ? "" : `; UI expected ${esc(run.expectedCitationCount)}`}.</p>
<table><thead><tr><th>#</th><th>Article</th><th>Domain</th><th>Marker</th><th>Relation</th><th>Answer text</th></tr></thead><tbody>${citations}</tbody></table>
<h2>Debug screenshot</h2>
<img class="debug" src="/artifacts/${esc(run.id)}/screenshot.png" alt="Run screenshot" />`,
  );
}

async function sourcesPage() {
  const aggregate = await store.aggregateSources();
  const domains = aggregate.topDomains
    .slice(0, 30)
    .map((row) => `<tr><td>${esc(row.domain)}</td><td>${row.count}</td></tr>`)
    .join("");
  const articles = aggregate.topArticles
    .slice(0, 50)
    .map(
      (row) => `<tr><td><a href="${esc(row.canonicalUrl)}" target="_blank" rel="noreferrer">${esc(row.title || row.canonicalUrl)}</a></td><td>${esc(row.domain)}</td><td>${row.count}</td></tr>`,
    )
    .join("");
  return layout(
    "Sources",
    `<h1>Sources</h1>
<p class="muted">这里只聚合 DOM 中确认可见的来源，不把搜索请求、训练数据或网络检索结果冒充 Citation。</p>
<h2>Top domains</h2><table><thead><tr><th>Domain</th><th>Citations</th></tr></thead><tbody>${domains}</tbody></table>
<h2>Top articles</h2><table><thead><tr><th>Article</th><th>Domain</th><th>Citations</th></tr></thead><tbody>${articles}</tbody></table>`,
  );
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/") return send(res, 200, await overviewPage());
    if (url.pathname === "/sources") return send(res, 200, await sourcesPage());
    if (url.pathname === "/api/runs") {
      return send(res, 200, JSON.stringify(await store.listRuns()), "application/json; charset=utf-8");
    }

    const apiRun = url.pathname.match(/^\/api\/runs\/(run_[A-Za-z0-9_-]+)$/);
    if (apiRun) {
      return send(res, 200, JSON.stringify(await store.readRun(apiRun[1])), "application/json; charset=utf-8");
    }

    const runMatch = url.pathname.match(/^\/runs\/(run_[A-Za-z0-9_-]+)$/);
    if (runMatch) return send(res, 200, await runPage(runMatch[1]));

    const artifact = url.pathname.match(
      /^\/artifacts\/(run_[A-Za-z0-9_-]+)\/([A-Za-z0-9._-]+)$/,
    );
    if (artifact) {
      const file = path.join(store.runDir(artifact[1]), artifact[2]);
      const data = await readFile(file);
      const type = artifact[2].endsWith(".png")
        ? "image/png"
        : artifact[2].endsWith(".json")
          ? "application/json; charset=utf-8"
          : "text/plain; charset=utf-8";
      return send(res, 200, data, type);
    }

    send(res, 404, layout("Not found", "<h1>404</h1>"));
  } catch (error) {
    send(
      res,
      500,
      layout(
        "Error",
        `<h1>Server error</h1><pre>${esc(error instanceof Error ? error.stack || error.message : String(error))}</pre>`,
      ),
    );
  }
});

server.listen(config.port, "127.0.0.1", () => {
  console.log(`OneGl MVP dashboard: http://127.0.0.1:${config.port}`);
});
