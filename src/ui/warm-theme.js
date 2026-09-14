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
`;
