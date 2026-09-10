/** Dashboard stylesheet. Kept inline so the server stays a single dependency-free process. */
export const STYLE = `
:root {
  color-scheme: dark;
  --bg: #0e1116;
  --bg-elevated: #151a21;
  --bg-hover: #1b222b;
  --border: #252c36;
  --border-strong: #333c48;
  --text: #e6e9ee;
  --text-muted: #98a2b3;
  --text-dim: #6b7684;
  --accent: #5b9cf8;
  --accent-soft: #1d2b41;
  --ok: #4ec9a2;
  --ok-soft: #12291f;
  --warn: #e5b567;
  --warn-soft: #2c2416;
  --bad: #ef7a72;
  --bad-soft: #2e1a19;
  --radius: 12px;
  --radius-sm: 8px;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif;
  font-size: 14px;
  line-height: 1.6;
}

a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }

.topbar {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 0 24px;
  height: 56px;
  border-bottom: 1px solid var(--border);
  background: rgba(14, 17, 22, 0.92);
  backdrop-filter: blur(10px);
  position: sticky;
  top: 0;
  z-index: 20;
}
.brand { font-weight: 650; letter-spacing: 0.3px; }
.brand small { color: var(--text-dim); font-weight: 400; margin-left: 8px; font-size: 12px; }
.nav { display: flex; gap: 4px; margin-left: 8px; }
.nav a {
  padding: 6px 12px;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: 13px;
}
.nav a:hover { background: var(--bg-hover); text-decoration: none; color: var(--text); }
.nav a.active { background: var(--accent-soft); color: var(--accent); }
.topbar .spacer { flex: 1; }
.topbar .db-state { font-size: 12px; color: var(--text-dim); }

main { max-width: 1280px; margin: 0 auto; padding: 24px; }

h1 { font-size: 22px; margin: 0 0 4px; font-weight: 650; }
h2 { font-size: 16px; margin: 28px 0 12px; font-weight: 600; }
h3 { font-size: 14px; margin: 20px 0 8px; font-weight: 600; color: var(--text-muted); }
p.lead { color: var(--text-muted); margin: 0 0 20px; }
p.hint { color: var(--text-dim); font-size: 12.5px; margin: 8px 0 0; }

.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
.metric {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px 16px;
}
.metric .label { color: var(--text-muted); font-size: 12.5px; }
.metric .value { font-size: 26px; font-weight: 650; margin-top: 4px; letter-spacing: -0.5px; }
.metric .hint { color: var(--text-dim); font-size: 11.5px; margin-top: 4px; line-height: 1.45; }
.metric.ok .value { color: var(--ok); }
.metric.warn .value { color: var(--warn); }
.metric.bad .value { color: var(--bad); }
.metric.info .value { color: var(--accent); }

.panel {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
.panel + .panel { margin-top: 12px; }
.panel-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.panel-head strong { font-weight: 600; font-size: 14px; }
.panel-head span { color: var(--text-dim); font-size: 12.5px; }
.panel-body { padding: 4px 0; }
.panel-body.padded { padding: 16px; }

table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 10px 16px; border-bottom: 1px solid var(--border); vertical-align: top; }
th { color: var(--text-muted); font-weight: 500; font-size: 12.5px; white-space: nowrap; }
tbody tr:last-child td { border-bottom: none; }
tbody tr:hover { background: var(--bg-hover); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
td.mono, .mono { font-family: var(--mono); font-size: 12px; }
td.nowrap, th.nowrap { white-space: nowrap; }

.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  border: 1px solid var(--border-strong);
  color: var(--text-muted);
  white-space: nowrap;
}
.badge.ok { background: var(--ok-soft); border-color: #1f4a3a; color: var(--ok); }
.badge.warn { background: var(--warn-soft); border-color: #4a3d20; color: var(--warn); }
.badge.bad { background: var(--bad-soft); border-color: #4d2a27; color: var(--bad); }
.badge.info { background: var(--accent-soft); border-color: #26405f; color: var(--accent); }
.badge.muted { background: transparent; }

.empty { padding: 28px 16px; text-align: center; color: var(--text-dim); }

pre {
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 14px;
  margin: 0;
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.65;
  max-height: 460px;
  overflow: auto;
}
code, kbd {
  font-family: var(--mono);
  font-size: 12.5px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 1px 6px;
}
.cmd {
  display: block;
  margin: 6px 0;
  padding: 9px 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: 6px;
  font-family: var(--mono);
  font-size: 12.5px;
  color: var(--text);
  overflow-x: auto;
  white-space: pre;
}

.kv { display: grid; grid-template-columns: 150px 1fr; gap: 6px 16px; padding: 16px; }
.kv dt { color: var(--text-muted); font-size: 13px; }
.kv dd { margin: 0; font-size: 13px; word-break: break-all; }

.notice {
  border-radius: var(--radius);
  padding: 14px 16px;
  margin-bottom: 16px;
  font-size: 13px;
  border: 1px solid var(--border-strong);
  background: var(--bg-elevated);
}
.notice.warn { background: var(--warn-soft); border-color: #4a3d20; color: #f0d5a0; }
.notice.bad { background: var(--bad-soft); border-color: #4d2a27; color: #f6b9b3; }
.notice a { color: inherit; text-decoration: underline; }

.bar { height: 6px; background: var(--bg); border-radius: 999px; overflow: hidden; min-width: 70px; }
.bar > span { display: block; height: 100%; background: var(--accent); border-radius: 999px; }
.bar.ok > span { background: var(--ok); }
.bar.warn > span { background: var(--warn); }
.bar.bad > span { background: var(--bad); }

.term {
  color: var(--text);
  background: var(--accent-soft);
  border: 1px solid #26405f;
  border-radius: 6px;
  padding: 0 5px;
  font-size: 12.5px;
}

details summary { cursor: pointer; color: var(--accent); font-size: 13px; padding: 6px 0; }
details pre { margin-top: 8px; }

.filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 14px; }
.filters a {
  padding: 5px 11px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 12.5px;
}
.filters a:hover { background: var(--bg-hover); text-decoration: none; }
.filters a.active { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }

.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
@media (max-width: 900px) { .grid-2 { grid-template-columns: 1fr; } }

footer {
  max-width: 1280px;
  margin: 32px auto 0;
  padding: 16px 24px 32px;
  color: var(--text-dim);
  font-size: 12px;
}

img.shot { max-width: 100%; border: 1px solid var(--border); border-radius: var(--radius-sm); display: block; }

/* 表单与标签页 */
.tabs {
  display: flex;
  gap: 2px;
  border-bottom: 1px solid var(--border);
  margin: 0 0 22px;
  flex-wrap: wrap;
}
.tabs a {
  padding: 9px 14px;
  color: var(--text-muted);
  font-size: 13.5px;
  border-bottom: 2px solid transparent;
}
.tabs a:hover { color: var(--text); text-decoration: none; }
.tabs a.active { color: var(--accent); border-bottom-color: var(--accent); }

input[type="text"], input[type="number"], select, textarea {
  width: 100%;
  background: var(--bg);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  color: var(--text);
  padding: 9px 12px;
  font-family: inherit;
  font-size: 13.5px;
  line-height: 1.6;
}
input::placeholder, textarea::placeholder { color: var(--text-dim); }
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent); }
textarea { min-height: 104px; resize: vertical; }

button {
  background: var(--accent);
  color: #06101d;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  padding: 9px 16px;
  font-size: 13.5px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
}
button:hover { filter: brightness(1.1); }
button.ghost {
  background: transparent;
  color: var(--text-muted);
  border: 1px solid var(--border-strong);
  font-weight: 400;
  padding: 4px 10px;
  font-size: 12px;
}
button.ghost:hover { background: var(--bg-hover); color: var(--text); filter: none; }
button.ghost.danger { color: var(--bad); border-color: #4d2a27; }
button.ghost.danger:hover { background: var(--bad-soft); }

.form-row { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field > label { color: var(--text-muted); font-size: 12.5px; }
.field.grow { flex: 1; min-width: 180px; }
.field.narrow input { width: 110px; }
.form-block { display: flex; flex-direction: column; gap: 12px; }
.inline-form { display: inline; }
.actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }

details.help { margin: 10px 0 0; }
details.help summary { color: var(--text-dim); font-size: 12.5px; }
details.help div { color: var(--text-dim); font-size: 12.5px; line-height: 1.7; padding: 6px 0 0; }
`;
