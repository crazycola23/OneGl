/**
 * OneGl 操作台设计系统。
 *
 * 设计语言：飞行仪表台。石墨底、仪表金、状态灯。
 * 扁平、细边框、无阴影、无渐变——信息本身就是装饰。
 *
 * 颜色只在三种场合出现：
 *   金色   —— 主动作、关键数字、当前导航
 *   状态色 —— 绿(正常) / 琥珀(等待) / 红(需处理) / 蓝(进行中)
 *   灰阶   —— 其它一切
 */
export const STYLE = `
:root {
  color-scheme: dark;
  --bg: #0B0D10;
  --bg-soft: #0E1116;
  --surface: #12161C;
  --surface-2: #161B22;
  --surface-3: #1B212A;
  --border: #21293233;
  --border-solid: #212932;
  --border-strong: #303B48;

  --text: #DDE5EE;
  --text-2: #93A1B1;
  --text-3: #5E6B7A;

  --accent: #E2A92C;
  --accent-ink: #1A1204;
  --accent-soft: rgba(226, 169, 44, 0.10);
  --accent-line: #5A4517;

  --ok: #55C482;
  --ok-soft: rgba(85, 196, 130, 0.11);
  --ok-line: #1E4630;

  --warn: #D9A03F;
  --warn-soft: rgba(217, 160, 63, 0.11);
  --warn-line: #4A3A17;

  --bad: #E0655A;
  --bad-soft: rgba(224, 101, 90, 0.12);
  --bad-line: #52241F;

  --info: #6EA3D8;
  --info-soft: rgba(110, 163, 216, 0.11);
  --info-line: #2B4258;

  --radius: 8px;
  --radius-sm: 5px;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif;
}

* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--sans);
  font-size: 13.5px;
  line-height: 1.62;
}

a { color: var(--info); text-decoration: none; }
a:hover { text-decoration: underline; }

::selection { background: var(--accent-soft); }

/* ----------------------------------------------------------------- 骨架 */

.deck { display: flex; min-height: 100vh; }

.side {
  width: 236px;
  flex: none;
  display: flex;
  flex-direction: column;
  background: var(--bg-soft);
  border-right: 1px solid var(--border-solid);
  position: sticky;
  top: 0;
  height: 100vh;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 18px 20px 16px;
  border-bottom: 1px solid var(--border-solid);
}
.brand .mark {
  width: 10px; height: 10px; flex: none;
  background: var(--accent);
  border-radius: 2px;
  box-shadow: 0 0 10px rgba(226, 169, 44, 0.45);
}
.brand .name { font-weight: 700; font-size: 15px; letter-spacing: 0.4px; }
.brand .sub {
  display: block;
  font-size: 9.5px;
  letter-spacing: 0.24em;
  color: var(--text-3);
  margin-top: 1px;
}

.nav { padding: 14px 12px; flex: 1; overflow-y: auto; }
.nav-group {
  font-size: 10px;
  letter-spacing: 0.18em;
  color: var(--text-3);
  padding: 12px 10px 6px;
}
.nav-group:first-child { padding-top: 0; }
.nav a {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  color: var(--text-2);
  font-size: 13px;
  border-left: 2px solid transparent;
}
.nav a:hover { background: var(--surface-2); color: var(--text); text-decoration: none; }
.nav a .pip {
  width: 5px; height: 5px; border-radius: 1px;
  background: var(--border-strong); flex: none;
}
.nav a.active {
  color: var(--accent);
  background: var(--accent-soft);
  border-left-color: var(--accent);
}
.nav a.active .pip { background: var(--accent); }

/* 侧栏底部：系统就绪状态 */
.deck-status {
  border-top: 1px solid var(--border-solid);
  padding: 14px 16px 16px;
}
.verdict {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.06em;
  margin-bottom: 12px;
}
.verdict.ready { color: var(--ok); }
.verdict.blocked { color: var(--bad); }
.verdict .lamp { width: 9px; height: 9px; }

.lamps { list-style: none; margin: 0; padding: 0; }
.lamps li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
  font-size: 12px;
  color: var(--text-2);
}
.lamps li b { margin-left: auto; font-weight: 600; font-variant-numeric: tabular-nums; }
.lamps li b.ok { color: var(--ok); }
.lamps li b.warn { color: var(--warn); }
.lamps li b.bad { color: var(--bad); }
.lamps li b.info { color: var(--info); }
.lamps li b.muted { color: var(--text-3); }

.lamp {
  width: 7px; height: 7px; border-radius: 50%;
  display: inline-block; flex: none;
  background: var(--text-3);
}
.lamp.ok { background: var(--ok); box-shadow: 0 0 6px rgba(85, 196, 130, 0.6); }
.lamp.warn { background: var(--warn); box-shadow: 0 0 6px rgba(217, 160, 63, 0.6); }
.lamp.bad { background: var(--bad); box-shadow: 0 0 6px rgba(224, 101, 90, 0.6); }
.lamp.info { background: var(--info); box-shadow: 0 0 6px rgba(110, 163, 216, 0.6); }
.lamp.muted { background: var(--border-strong); }

.main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
main { flex: 1; width: 100%; max-width: 1180px; margin: 0 auto; padding: 28px 32px 40px; }

/* -------------------------------------------------------------- 页头 */

.page-head { margin-bottom: 22px; }
.page-kicker {
  font-size: 10.5px;
  letter-spacing: 0.18em;
  color: var(--text-3);
  margin-bottom: 6px;
}
.page-kicker a { color: var(--text-3); }
.page-kicker a:hover { color: var(--text-2); }
.page-title-row {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}
.page-title-row h1 {
  font-size: 20px;
  font-weight: 650;
  letter-spacing: 0.01em;
  margin: 0;
}
.page-actions { margin-left: auto; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.page-sub { color: var(--text-2); font-size: 13px; margin-top: 6px; }
.page-sub code { font-size: 12px; }

/* -------------------------------------------------------------- 卡片 */

.card {
  background: var(--surface);
  border: 1px solid var(--border-solid);
  border-radius: var(--radius);
  margin-bottom: 14px;
  overflow: hidden;
}
.card.tone-blocked { border-color: var(--bad-line); }
.card.tone-warn { border-color: var(--warn-line); }

.card-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 11px 16px;
  border-bottom: 1px solid var(--border-solid);
}
.card-head strong { font-size: 13px; font-weight: 650; }
.card-head span { color: var(--text-3); font-size: 12px; }
.card-head .card-actions { margin-left: auto; display: flex; gap: 6px; align-items: center; }
.card-body { padding: 4px 0; }
.card-body.pad { padding: 16px; }

/* -------------------------------------------------------------- 指标 */

.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 1px;
  background: var(--border-solid);
  border: 1px solid var(--border-solid);
  border-radius: var(--radius);
  overflow: hidden;
  margin-bottom: 14px;
}
.stat {
  background: var(--surface);
  padding: 13px 16px 12px;
  border-top: 2px solid transparent;
}
.stat .label {
  font-size: 10.5px;
  letter-spacing: 0.12em;
  color: var(--text-3);
}
.stat .value {
  font-size: 22px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
  margin-top: 4px;
  line-height: 1.15;
}
.stat .value small { font-size: 13px; font-weight: 500; color: var(--text-2); margin-left: 3px; }
.stat .hint { color: var(--text-3); font-size: 11.5px; margin-top: 4px; line-height: 1.5; }
.stat.ok { border-top-color: var(--ok); }
.stat.ok .value { color: var(--ok); }
.stat.warn { border-top-color: var(--warn); }
.stat.warn .value { color: var(--warn); }
.stat.bad { border-top-color: var(--bad); }
.stat.bad .value { color: var(--bad); }
.stat.info { border-top-color: var(--info); }
.stat.info .value { color: var(--info); }

/* -------------------------------------------------------------- 表格 */

table { width: 100%; border-collapse: collapse; }
th, td {
  text-align: left;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border-solid);
  vertical-align: top;
  font-size: 13px;
}
th {
  color: var(--text-3);
  font-weight: 500;
  font-size: 10.5px;
  letter-spacing: 0.1em;
  white-space: nowrap;
  text-transform: none;
  background: var(--surface-2);
}
tbody tr:last-child td { border-bottom: none; }
tbody tr:hover { background: var(--surface-2); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
td.mono, .mono { font-family: var(--mono); font-size: 12px; }
td.nowrap, th.nowrap { white-space: nowrap; }

tbody tr.row-bad td { background: rgba(224, 101, 90, 0.06); }
tbody tr.row-bad:hover td { background: rgba(224, 101, 90, 0.11); }
tbody tr.row-warn td { background: rgba(217, 160, 63, 0.05); }

/* -------------------------------------------------------------- 徽章 */

.badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11.5px;
  font-weight: 500;
  border: 1px solid var(--border-strong);
  color: var(--text-2);
  white-space: nowrap;
  line-height: 1.7;
}
.badge.ok { background: var(--ok-soft); border-color: var(--ok-line); color: var(--ok); }
.badge.warn { background: var(--warn-soft); border-color: var(--warn-line); color: var(--warn); }
.badge.bad { background: var(--bad-soft); border-color: var(--bad-line); color: var(--bad); }
.badge.info { background: var(--info-soft); border-color: var(--info-line); color: var(--info); }
.badge.muted { background: transparent; color: var(--text-3); }

/* -------------------------------------------------------------- 通知 */

.notice {
  border-radius: var(--radius);
  padding: 12px 16px;
  margin-bottom: 14px;
  font-size: 13px;
  border: 1px solid var(--border-strong);
  border-left-width: 3px;
  background: var(--surface);
}
.notice.ok { border-left-color: var(--ok); }
.notice.warn { border-left-color: var(--warn); background: var(--warn-soft); }
.notice.bad { border-left-color: var(--bad); background: var(--bad-soft); }
.notice a { color: inherit; text-decoration: underline; }

/* -------------------------------------------------------------- 进度 */

.bar {
  height: 6px;
  background: var(--surface-3);
  border-radius: 2px;
  overflow: hidden;
  min-width: 70px;
}
.bar > span { display: block; height: 100%; background: var(--info); }
.bar.ok > span { background: var(--ok); }
.bar.warn > span { background: var(--warn); }
.bar.bad > span { background: var(--bad); }

.bar.stacked { display: flex; height: 12px; border-radius: 2px; }
.bar.stacked > i { display: block; height: 100%; }
.bar.stacked > i.ok { background: var(--ok); }
.bar.stacked > i.warn { background: var(--warn); }
.bar.stacked > i.bad { background: var(--bad); }
.bar.stacked > i.muted { background: var(--border-strong); }
.bar.stacked > i.info { background: var(--info); }
.bar.stacked > i + i { border-left: 1px solid var(--bg); }

.progress-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}
.progress-head .count {
  font-size: 26px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
}
.progress-head .pct { color: var(--text-2); font-size: 12.5px; font-variant-numeric: tabular-nums; }

.legend { display: flex; flex-wrap: wrap; gap: 8px 16px; margin-top: 12px; font-size: 12px; }
.legend span { display: inline-flex; align-items: center; gap: 6px; color: var(--text-2); }
.legend i { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
.legend i.ok { background: var(--ok); }
.legend i.warn { background: var(--warn); }
.legend i.bad { background: var(--bad); }
.legend i.muted { background: var(--border-strong); }
.legend i.info { background: var(--info); }
.legend b { color: var(--text); font-variant-numeric: tabular-nums; }

/* -------------------------------------------------------------- 空状态 */

.empty { padding: 34px 18px; text-align: center; }
.empty-title { color: var(--text-2); font-size: 13.5px; font-weight: 550; }
.empty-hint { color: var(--text-3); font-size: 12.5px; margin-top: 7px; line-height: 1.7; }
.empty-action { margin-top: 14px; }

/* -------------------------------------------------------------- 代码 */

pre {
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--bg-soft);
  border: 1px solid var(--border-solid);
  border-radius: var(--radius-sm);
  padding: 13px 15px;
  margin: 0;
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.7;
  max-height: 480px;
  overflow: auto;
}
code, kbd {
  font-family: var(--mono);
  font-size: 12px;
  background: var(--bg-soft);
  border: 1px solid var(--border-solid);
  border-radius: 4px;
  padding: 1px 6px;
}
.cmd {
  display: block;
  margin: 6px 0;
  padding: 9px 12px;
  background: var(--bg-soft);
  border: 1px solid var(--border-solid);
  border-left: 2px solid var(--accent);
  border-radius: var(--radius-sm);
  font-family: var(--mono);
  font-size: 12.5px;
  color: var(--text);
  overflow-x: auto;
  white-space: pre;
}

.kv { display: grid; grid-template-columns: 160px 1fr; gap: 7px 18px; padding: 14px 16px; }
.kv dt { color: var(--text-3); font-size: 12.5px; }
.kv dd { margin: 0; font-size: 13px; word-break: break-all; }

/* -------------------------------------------------------------- 表单 */

input[type="text"], input[type="number"], select, textarea {
  width: 100%;
  background: var(--bg-soft);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  color: var(--text);
  padding: 8px 11px;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.6;
}
input::placeholder, textarea::placeholder { color: var(--text-3); }
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent); }
textarea { min-height: 104px; resize: vertical; }

button {
  background: var(--accent);
  color: var(--accent-ink);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  padding: 8px 15px;
  font-size: 13px;
  font-weight: 650;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
  letter-spacing: 0.02em;
}
button:hover { filter: brightness(1.08); }
button:disabled { opacity: 0.4; cursor: not-allowed; filter: none; }

button.ghost {
  background: transparent;
  color: var(--text-2);
  border: 1px solid var(--border-strong);
  font-weight: 500;
  padding: 4px 10px;
  font-size: 12px;
}
button.ghost:hover { background: var(--surface-2); color: var(--text); filter: none; }
button.ghost.danger { color: var(--bad); border-color: var(--bad-line); }
button.ghost.danger:hover { background: var(--bad-soft); }
button.ghost.warn { color: var(--warn); border-color: var(--warn-line); }
button.ghost.warn:hover { background: var(--warn-soft); }

.linkbtn {
  display: inline-block;
  padding: 4px 10px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--text-2);
}
.linkbtn:hover { background: var(--surface-2); color: var(--text); text-decoration: none; }
.linkbtn.primary { background: var(--accent); border-color: transparent; color: var(--accent-ink); font-weight: 650; }
.linkbtn.danger { color: var(--bad); border-color: var(--bad-line); }

.form-row { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field > label { color: var(--text-3); font-size: 12px; }
.field.grow { flex: 1; min-width: 170px; }
.field.narrow input { width: 110px; }
.form-block { display: flex; flex-direction: column; gap: 14px; }
.inline-form { display: inline; }
.actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }

/* -------------------------------------------------------------- 筛选 */

.filters { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 14px; }
.filters a {
  padding: 4px 11px;
  border-radius: 999px;
  border: 1px solid var(--border-solid);
  color: var(--text-2);
  font-size: 12px;
}
.filters a:hover { background: var(--surface-2); text-decoration: none; }
.filters a.active { border-color: var(--accent-line); color: var(--accent); background: var(--accent-soft); }

/* -------------------------------------------------------------- 杂项 */

.hint { color: var(--text-3); font-size: 12px; margin: 4px 0 0; }
p.lead { color: var(--text-2); margin: 0 0 18px; }
h3 { font-size: 13px; margin: 18px 0 8px; font-weight: 600; color: var(--text-2); }

.term {
  color: var(--text);
  background: var(--info-soft);
  border: 1px solid var(--info-line);
  border-radius: 4px;
  padding: 0 5px;
  font-size: 12px;
}

details summary { cursor: pointer; color: var(--info); font-size: 12.5px; padding: 6px 0; }
details pre { margin-top: 8px; }
details.help { margin: 10px 0 0; }
details.help summary { color: var(--text-3); font-size: 12px; }
details.help div { color: var(--text-3); font-size: 12.5px; line-height: 1.7; padding: 6px 0 0; }

.grid-2 { display: grid; grid-template-columns: 1.4fr 1fr; gap: 14px; align-items: start; }
@media (max-width: 900px) { .grid-2 { grid-template-columns: 1fr; } }

img.shot { max-width: 100%; border: 1px solid var(--border-solid); border-radius: var(--radius-sm); display: block; }

footer {
  max-width: 1180px;
  margin: 0 auto;
  padding: 18px 32px 30px;
  color: var(--text-3);
  font-size: 11.5px;
  border-top: 1px solid var(--border-solid);
}

/* -------------------------------------------------------------- 阻塞项 */

.blocker {
  display: flex;
  gap: 12px;
  padding: 11px 16px;
  border-bottom: 1px solid var(--border-solid);
  font-size: 13px;
  align-items: flex-start;
}
.blocker:last-child { border-bottom: none; }
.blocker .body { min-width: 0; }
.blocker .fix { color: var(--text-3); font-size: 12px; margin-top: 3px; }

/* -------------------------------------------------------------- 时间线 */

.timeline { padding: 4px 0; }
.timeline-row {
  display: grid;
  grid-template-columns: 108px 120px 1fr;
  gap: 14px;
  padding: 11px 16px;
  border-bottom: 1px solid var(--border-solid);
  font-size: 13px;
}
.timeline-row:last-child { border-bottom: none; }
.timeline-row .when { color: var(--text-2); font-variant-numeric: tabular-nums; }
.timeline-row .artifacts { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }

/* -------------------------------------------------------------- 账号选择 */

.account-pick {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-solid);
  border-radius: var(--radius-sm);
  max-height: 240px;
  overflow: auto;
  background: var(--bg-soft);
}
.account-pick label {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  font-size: 13px;
  cursor: pointer;
  border-bottom: 1px solid var(--border-solid);
}
.account-pick label:last-child { border-bottom: none; }
.account-pick label:hover { background: var(--surface-2); }
.account-pick label.blocked { opacity: 0.5; cursor: not-allowed; }
.account-pick input[type="checkbox"] { accent-color: var(--accent); width: 15px; height: 15px; }
.account-pick .meta { margin-left: auto; color: var(--text-3); font-size: 12px; }

.total-preview {
  display: flex;
  gap: 22px;
  flex-wrap: wrap;
  background: var(--bg-soft);
  border: 1px solid var(--border-solid);
  border-radius: var(--radius-sm);
  padding: 13px 16px;
  font-size: 13px;
}
.total-preview b { font-size: 18px; font-variant-numeric: tabular-nums; display: block; margin-top: 2px; }
.safe { color: var(--ok); }
.risky { color: var(--warn); }

.tabs {
  display: flex;
  gap: 2px;
  border-bottom: 1px solid var(--border-solid);
  margin: 0 0 20px;
  flex-wrap: wrap;
}
.tabs a {
  padding: 8px 13px;
  color: var(--text-2);
  font-size: 13px;
  border-bottom: 2px solid transparent;
}
.tabs a:hover { color: var(--text); text-decoration: none; }
.tabs a.active { color: var(--accent); border-bottom-color: var(--accent); }

@media (max-width: 860px) {
  .side { display: none; }
  main { padding: 20px 16px 32px; }
}
`;
