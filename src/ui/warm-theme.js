export const WARM_THEME = `
:root {
  color-scheme: light;
  --bg: #F7F0E7;
  --bg-soft: #F1E6D9;
  --surface: #FFFDFC;
  --surface-2: #FBF4EC;
  --surface-3: #F5E9DC;
  --border: rgba(132, 93, 60, 0.12);
  --border-solid: #E6D5C4;
  --border-strong: #D5BDA7;

  --text: #382B23;
  --text-2: #766153;
  --text-3: #A18A78;

  --accent: #B55B34;
  --accent-ink: #FFF9F4;
  --accent-soft: rgba(181, 91, 52, 0.10);
  --accent-line: #D8A384;

  --ok: #667E4D;
  --ok-soft: rgba(102, 126, 77, 0.11);
  --ok-line: #B9C8A8;

  --warn: #BF852F;
  --warn-soft: rgba(191, 133, 47, 0.12);
  --warn-line: #DFC18E;

  --bad: #B64E3E;
  --bad-soft: rgba(182, 78, 62, 0.11);
  --bad-line: #DDA89F;

  --info: #5E7F80;
  --info-soft: rgba(94, 127, 128, 0.11);
  --info-line: #AFC4C2;
}

body {
  background:
    radial-gradient(circle at 82% 8%, rgba(210, 151, 83, 0.09), transparent 24rem),
    var(--bg);
}

.side {
  background: linear-gradient(180deg, #F3E8DC 0%, #EFE1D2 100%);
  box-shadow: 10px 0 34px rgba(104, 72, 45, 0.05);
}

.brand .mark {
  border-radius: 50%;
  box-shadow: 0 0 0 5px rgba(181, 91, 52, 0.09);
}

.nav a:hover { background: rgba(255, 253, 250, 0.75); }
.nav a.active {
  background: rgba(255, 253, 250, 0.92);
  box-shadow: inset 0 0 0 1px rgba(181, 91, 52, 0.09);
}

.card,
.stat,
.empty,
input,
select,
textarea {
  box-shadow: 0 8px 28px rgba(95, 63, 39, 0.045);
}

.card {
  border-color: var(--border-solid);
}

.card-head {
  background: linear-gradient(180deg, rgba(255, 253, 250, 0.98), rgba(251, 244, 236, 0.72));
}

.stats {
  box-shadow: 0 8px 28px rgba(95, 63, 39, 0.04);
}

.stat .value,
.count {
  color: var(--text);
}

button,
.linkbtn.primary {
  box-shadow: 0 5px 14px rgba(181, 91, 52, 0.15);
}

button:not(.ghost) {
  background: var(--accent);
  color: var(--accent-ink);
}

button:not(.ghost):hover {
  background: #A84D2A;
}

.linkbtn,
button.ghost {
  background: rgba(255, 253, 250, 0.76);
  border-color: var(--border-strong);
  color: var(--text);
}

.linkbtn:hover,
button.ghost:hover {
  background: #FFF9F3;
  border-color: #CBA98B;
}

.notice {
  background: #FBF2E8;
  border-color: #E8D4BE;
}

.notice.warn { background: #FFF4DF; border-color: #E8C98D; }
.notice.bad { background: #FBEAE6; border-color: #E2B1A7; }

thead th {
  background: #F6EBDD;
  color: #765F50;
}

tbody tr:hover { background: #FFF8F1; }

code.cmd {
  background: #F4E8DB;
  border-color: #DEC8B3;
  color: #684B38;
}

.filters a {
  background: rgba(255, 253, 250, 0.7);
}
.filters a.active {
  background: var(--accent-soft);
  border-color: var(--accent-line);
  color: #8E4326;
}

.progress-head .count { color: #9E4B2A; }

.bar { background: #EFE1D4; }

footer {
  color: var(--text-3);
  border-top-color: var(--border-solid);
}

#batch-professional-evaluation .eval-score {
  font-size: 25px;
  font-weight: 750;
  letter-spacing: -0.02em;
}
#batch-professional-evaluation .eval-score.good { color: var(--ok); }
#batch-professional-evaluation .eval-score.warn { color: var(--warn); }
#batch-professional-evaluation .eval-score.bad { color: var(--bad); }
#batch-professional-evaluation .eval-reco {
  padding: 12px 14px;
  border-top: 1px solid var(--border-solid);
}
#batch-professional-evaluation .eval-reco:first-child { border-top: 0; }
#batch-professional-evaluation .eval-priority {
  display: inline-flex;
  min-width: 34px;
  justify-content: center;
  padding: 1px 8px;
  margin-right: 7px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: #8E4326;
  font-size: 11px;
  font-weight: 750;
}

/* ------------------------------------------------------------ 对话档案 */
/* 档案页的核心是「读原文」，所以排版以可读性优先：正文行高放宽、
   引用域名做成小标签便于扫读、折叠项默认收起避免一次铺开几十屏。 */

.cv-list { display: flex; flex-direction: column; gap: 6px; }

.cv-item {
  border: 1px solid var(--border-solid);
  border-radius: 9px;
  background: var(--surface);
  overflow: hidden;
}
.cv-item[data-tone="bad"] { border-color: var(--bad-line); }

.cv-item > summary {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 13px;
  cursor: pointer;
  list-style: none;
  flex-wrap: wrap;
}
.cv-item > summary::-webkit-details-marker { display: none; }
.cv-item > summary:hover { background: var(--surface-2); }
.cv-item[open] > summary { border-bottom: 1px solid var(--border); }

.cv-item-status, .cv-item-provider { flex: none; }
.cv-item-q { font-size: 13.5px; font-weight: 550; flex: 1 1 260px; min-width: 0; }
.cv-item-meta {
  flex: none;
  color: var(--text-3);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.cv-item-body { padding: 13px 15px 15px; }
.cv-label {
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--text-3);
  margin: 12px 0 5px;
  text-transform: uppercase;
}
.cv-item-body > .cv-label:first-child { margin-top: 0; }

.cv-q-full {
  padding: 9px 12px;
  background: var(--surface-2);
  border-left: 2px solid var(--accent);
  border-radius: 0 7px 7px 0;
  font-size: 13.5px;
  font-weight: 550;
}

/* 回答正文：只转义不渲染 markdown，保证屏幕上看到的就是数据库里的原文。 */
.cv-answer {
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.85;
  font-size: 13.5px;
  color: var(--text);
  padding: 12px 14px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  max-height: 32rem;
  overflow-y: auto;
}
.cv-empty { color: var(--text-3); font-size: 13px; padding: 10px 0; }

.cv-marks { margin: 7px 0 0; display: flex; gap: 6px; flex-wrap: wrap; }

.cv-item-foot {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
  margin-top: 13px;
  padding-top: 11px;
  border-top: 1px solid var(--border);
  font-size: 12px;
}

.cv-domains { display: inline-flex; gap: 4px; flex-wrap: wrap; }
.cv-domain {
  display: inline-block;
  padding: 1px 7px;
  border-radius: 5px;
  background: var(--surface-3);
  border: 1px solid var(--border);
  color: var(--text-2);
  font-size: 11.5px;
  font-family: var(--mono, ui-monospace, monospace);
}
.cv-domain-more { color: var(--text-3); font-size: 11.5px; align-self: center; }

/* ---------------------------------------------------- 跨平台并排对照 */

.cv-pairs { display: flex; flex-direction: column; gap: 14px; }

.cv-pair {
  border: 1px solid var(--border-solid);
  border-radius: 10px;
  overflow: hidden;
  background: var(--surface);
}
.cv-pair-q {
  padding: 10px 14px;
  background: var(--surface-3);
  border-bottom: 1px solid var(--border);
  font-size: 13.5px;
  font-weight: 600;
}
.cv-pair-cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1px;
  background: var(--border);
}
.cv-pair-col { background: var(--surface); padding: 11px 13px 13px; min-width: 0; }
.cv-pair-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 12.5px;
  color: var(--text-2);
}
.cv-pair-col .cv-answer { max-height: 20rem; font-size: 13px; }
.cv-pair-foot { margin-top: 9px; font-size: 11.5px; color: var(--text-3); }

/* 单列：窄屏下并排会挤成两栏细缝，此时改为上下堆叠。 */
@media (max-width: 900px) {
  .cv-pair-cols { grid-template-columns: 1fr; }
}
`;
