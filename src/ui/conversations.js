import {
  escapeHtml,
  num,
  dateTime,
  statusLabel,
  statusTone,
  truncate,
  providerLabel,
} from "./format.js";
import {
  layout,
  pageHead,
  panel,
  metricGrid,
  metric,
  badge,
  dataTable,
  notice,
  emptyState,
} from "./layout.js";

/**
 * 对话档案页。
 *
 * 这页存在的理由：运营要核对的是「一次真实对话里到底发生了什么」，
 * 而不是聚合统计。问题、AI 回答、引用链接三者必须同屏可对照 ——
 * 统计页再怎么聚合都替代不了「读一遍原文，确认它真的这么说」。
 *
 * 三块内容按这个顺序：
 *   1. 批次口径（真实数字，不是估算）
 *   2. 跨平台并排对照（同一问题的两个答案，这是本页最不可替代的部分）
 *   3. 逐条档案流
 */

const PROVIDER_TONES = { qianwen: "info", doubao: "ok", zhipu: "warn", wenxin: "" };

/** 平台标签：千问蓝、豆包绿，与报告里的颜色约定一致。 */
export function providerBadge(provider) {
  if (!provider) return "—";
  return badge(providerLabel(provider), PROVIDER_TONES[provider] ?? "muted");
}

/**
 * AI 回答正文。
 *
 * 实测三个平台的回答正文都是纯文本：不带 markdown 标记（千问 97 条里
 * `**` 出现 0 次、`[]()` 出现 0 次），只有换行和 emoji。所以这里只做
 * 「转义 + 保留换行」，刻意不渲染 markdown —— 一旦回答里出现 `**`，
 * 原文和渲染结果就会不一致，核对页面最忌讳这个。
 */
function answerBody(answer) {
  if (!answer || !String(answer).trim()) {
    return `<div class="cv-empty">（未抓到回答）</div>`;
  }
  return `<div class="cv-answer">${escapeHtml(answer)}</div>`;
}

/** 回答是否可信：不完整或靠猜完成的要显式标出来。 */
function answerIntegrity(row) {
  const marks = [];
  if (row.answer_truncated === true) marks.push(badge("回答被截断", "warn"));
  if (row.answer_completion === "length-stability-fallback") {
    marks.push(badge("完成判据靠长度猜测", "warn"));
  }
  if (row.answer_completion === "timeout") marks.push(badge("超时返回", "bad"));
  if (row.status === "failed") marks.push(badge("本次失败", "bad"));
  if (!marks.length) return "";
  return `<div class="cv-marks">${marks.join(" ")}</div>`;
}

/**
 * 引用域名标签。
 *
 * limit 默认给足：单次对话引用的域名实测最多十几个，截断成 6 个会静默丢掉
 * 关键渠道（核对时正好丢的就是要看的那几个）。真正超出的部分用 +N 标出，
 * 但 title 属性保留完整列表，鼠标悬停可见。
 */
function domainChips(domains, limit = 20) {
  const list = Array.isArray(domains) ? domains : [];
  if (!list.length) return `<span class="muted">—</span>`;
  const shown = list.slice(0, limit);
  const rest = list.length - shown.length;
  return (
    `<span class="cv-domains"${rest > 0 ? ` title="另有 ${rest} 个：${escapeHtml(list.slice(limit).join("、"))}"` : ""}>${shown
      .map((d) => `<span class="cv-domain">${escapeHtml(d)}</span>`)
      .join("")}${rest > 0 ? `<span class="cv-domain-more">+${rest}</span>` : ""}</span>`
  );
}

/* --------------------------------------------------------------- 批次口径 */

function batchSection(summaries, { projectId }) {
  if (!summaries.length) return "";

  const rows = summaries
    .filter((s) => s.runs > 0)
    .map((s) => {
      const valid = s.success + s.partial;
      return {
        batch_id: s.batch_id,
        provider: s.provider,
        name: s.batch_name,
        runs: s.runs,
        ok: s.success,
        bad: s.failed,
        with_answer: s.with_answer,
        citations: s.citations,
        articles: s.unique_articles,
        domains: s.domains,
        rate: valid ? (s.with_answer / valid) * 100 : 0,
        date: dateTime(s.created_at),
        _raw: s,
      };
    });

  return panel("批次真实口径", {
    hint: "全部来自 citations / runs 实测，未做任何估算",
    actions: `<a class="linkbtn" href="/conversations${projectId ? `?project=${projectId}` : ""}">全部批次</a>`,
    body: dataTable({
      columns: [
        { label: "批次", render: (row) => `<a href="/batches/${row.batch_id}">#${row.batch_id}</a>` },
        { label: "平台", render: (row) => providerBadge(row.provider) },
        { label: "名称", render: (row) => escapeHtml(truncate(row.name, 34)) },
        { label: "运行", align: "right", render: (row) => num(row.runs) },
        { label: "成功", align: "right", render: (row) => num(row.ok) },
        { label: "失败", align: "right", render: (row) => (row.bad ? `<span class="risky">${num(row.bad)}</span>` : "0") },
        {
          label: "有回答",
          align: "right",
          render: (row) => `${num(row.with_answer)} / ${num(row.runs)}`,
        },
        { label: "引用", align: "right", render: (row) => num(row.citations) },
        { label: "唯一来源", align: "right", render: (row) => num(row.articles) },
        { label: "域名数", align: "right", render: (row) => num(row.domains) },
        { label: "采集时间", className: "nowrap", render: (row) => row.date },
      ],
      rows,
      rowKey: (row) => row.batch_id,
      rowTone: (row) => (row._raw.with_answer < row.runs * 0.5 ? "warn" : ""),
    }),
  });
}

/* ------------------------------------------------------- 跨平台并排对照 */

/**
 * 同一问题在两个平台上的回答并排。
 *
 * 这是整份数据最不可替代的部分：两边的问题池来自同一批 prompt，
 * 所以问题文本本身就是天然的连接键，无需任何人工配对。
 * 没有这一块，读者只能自己在两个批次之间来回跳，自己去猜哪两条是一对。
 */
function compareSection(pairs, { comparePair }) {
  if (!pairs.length) {
    return panel("跨平台并排对照", {
      hint: "需要两个批次共享同一批问题才会出现",
      body: emptyState("没有找到可并排对照的两个批次。", {
        hint: "跨平台对照要求两个批次问的是同一批问题。千问批次 #68 与豆包批次 #69 满足这个条件。",
      }),
    });
  }

  const cards = pairs
    .slice(0, 40)
    .map(
      (pair) => `<div class="cv-pair">
  <div class="cv-pair-q">${escapeHtml(pair.prompt)}</div>
  <div class="cv-pair-cols">
    <div class="cv-pair-col">
      <div class="cv-pair-head">${providerBadge(pair.left.provider)} <span class="muted">${num(pair.left.answer_chars ?? 0)} 字</span></div>
      ${answerBody(pair.left.answer)}
      <div class="cv-pair-foot">${domainChips(pair.left.cite_domains, 20)}</div>
    </div>
    <div class="cv-pair-col">
      <div class="cv-pair-head">${providerBadge(pair.right.provider)} <span class="muted">${num(pair.right.answer_chars ?? 0)} 字</span></div>
      ${answerBody(pair.right.answer)}
      <div class="cv-pair-foot">${domainChips(pair.right.cite_domains, 20)}</div>
    </div>
  </div>
</div>`,
    )
    .join("");

  return panel(`跨平台并排对照（${num(pairs.length)} 对）`, {
    hint: comparePair
      ? `同一问题的两个答案 ｜ 左 <a href="/batches/${comparePair.leftBatch}">#${comparePair.leftBatch} ${escapeHtml(providerLabel(comparePair.leftProvider))}</a> / 右 <a href="/batches/${comparePair.rightBatch}">#${comparePair.rightBatch} ${escapeHtml(providerLabel(comparePair.rightProvider))}</a> ｜ 两个批次共有 ${num(comparePair.overlap)} 个相同问题`
      : "同一问题的两个答案",
    body: `<div class="cv-pairs">${cards}</div>`,
  });
}

/* --------------------------------------------------------------- 档案流 */

function conversationCard(row) {
  const link = `/runs/${encodeURIComponent(row.local_run_id)}`;
  return `<details class="cv-item"${row.status === "failed" ? ' data-tone="bad"' : ""}>
  <summary>
    <span class="cv-item-status">${badge(statusLabel(row.status), statusTone(row.status))}</span>
    <span class="cv-item-provider">${providerBadge(row.provider)}</span>
    <span class="cv-item-q">${escapeHtml(truncate(row.prompt, 60))}</span>
    <span class="cv-item-meta">${row.answer_chars ? `${num(row.answer_chars)} 字` : "无回答"}${
      row.captured_citation_count ? ` · ${num(row.captured_citation_count)} 引用` : ""
    }</span>
  </summary>
  <div class="cv-item-body">
    <div class="cv-label">问题</div>
    <div class="cv-q-full">${escapeHtml(row.prompt)}</div>
    ${answerIntegrity(row)}
    <div class="cv-label">AI 回答</div>
    ${answerBody(row.answer)}
    <div class="cv-item-foot">
      <span class="muted">引用来源域名</span> ${domainChips(row.cite_domains)}
      <a class="linkbtn" href="${link}" target="_blank" rel="noreferrer">运行详情与引用链接</a>
    </div>
  </div>
</details>`;
}

/* ------------------------------------------------------------------ 页面 */

export function conversationsPage({
  db,
  system = null,
  summaries = [],
  pairs = [],
  comparePair = null,
  items = [],
  projects = [],
  batches = [],
  filters: state = {},
  totals = { hit: 0, shown: 0 },
}) {
  const body = [];

  if (!db.ready) {
    return layout({
      title: "对话档案",
      active: "conversations",
      system,
      body: `${pageHead({ kicker: "观测", title: "对话档案" })}${notice("未连接 PostgreSQL，无法读取对话档案。", "warn")}`,
    });
  }

  const sel = (value, current) => (String(value ?? "") === String(current ?? "") ? " selected" : "");

  body.push(
    panel("筛选", {
      hint: "检索同时匹配问题与 AI 回答正文，支持中文任意子串",
      body: `<div class="card-body pad">
        <form method="get" action="/conversations" class="form-row">
          <div class="field grow"><label>关键词（问题 + 回答）</label>
            <input type="search" name="q" value="${escapeHtml(state.query ?? "")}" placeholder="例如：思邈棠 / 携程 / 医保 / 手法" /></div>
          <div class="field grow"><label>平台</label>
            <select name="provider">
              <option value="">全部平台</option>
              ${[...new Set(summaries.map((s) => s.provider).filter(Boolean))]
                .map(
                  (p) =>
                    `<option value="${escapeHtml(p)}"${sel(p, state.provider)}>${escapeHtml(providerLabel(p))}</option>`,
                )
                .join("")}
            </select></div>
          <div class="field grow"><label>批次</label>
            <select name="batch">
              <option value="">全部批次</option>
              ${batches
                .map(
                  (b) =>
                    `<option value="${b.id}"${sel(b.id, state.batchId)}>#${b.id} ${escapeHtml(truncate(b.name, 26))}</option>`,
                )
                .join("")}
            </select></div>
          <div class="field grow"><label>项目</label>
            <select name="project">
              <option value="">全部项目</option>
              ${projects
                .map(
                  (p) => `<option value="${p.id}"${sel(p.id, state.projectId)}>${escapeHtml(p.name)}</option>`,
                )
                .join("")}
            </select></div>
          <button type="submit">筛选</button>
          <a class="linkbtn" href="/conversations">清除</a>
        </form>
      </div>`,
    }),
  );

  const exportBase = `/api/runs/export?${new URLSearchParams(
    Object.entries({
      batch: state.batchId ?? "",
      project: state.projectId ?? "",
      provider: state.provider ?? "",
      q: state.query ?? "",
    }).filter(([, v]) => v !== ""),
  ).toString()}`;

  body.push(
    metricGrid([
      metric({ label: "命中对话", value: num(totals.hit), hint: "符合当前筛选的运行条数" }),
      metric({ label: "本页展示", value: num(totals.shown), hint: "每页最多 60 条" }),
      metric({ label: "可配对问题", value: num(pairs.length), hint: "两个平台共享同一问题文本" }),
      metric({
        label: "导出",
        value: "HTML / JSON / CSV",
        hint: "导出内容与当前筛选一致",
      }),
    ]),
  );

  body.push(
    panel("批量导出", {
      hint: "导出的是结构化原文，不是渲染后的页面",
      body: `<div class="card-body pad">
        <div class="artifacts">
          <a class="linkbtn" href="${exportBase}&format=html" target="_blank" rel="noreferrer">导出 HTML 档案</a>
          <a class="linkbtn" href="${exportBase}&format=json" target="_blank" rel="noreferrer">导出 JSON</a>
          <a class="linkbtn" href="${exportBase}&format=csv" target="_blank" rel="noreferrer">导出 CSV</a>
        </div>
        <div class="hint">导出内容包含问题、回答全文、引用链接与批次口径。HTML 可直接用浏览器打开核对。</div>
      </div>`,
    }),
  );

  body.push(batchSection(summaries, { projectId: state.projectId }));

  // 何时显示并排对照：只在「没有收窄条件」时。
  // 收窄到某个批次、某个平台或某个关键词之后，读者要的是精确定位，
  // 摆一段 40 对的并排在结果上方反而挤掉了要看的东西。
  const showCompare = !state.batchId && !state.query && !state.provider;
  if (showCompare) {
    body.push(compareSection(pairs, { comparePair }));
  }

  body.push(
    panel(`对话档案（${num(items.length)}）`, {
      hint: "点任意一条展开完整问答与引用域名",
      body: items.length
        ? `<div class="cv-list">${items.map(conversationCard).join("")}</div>`
        : emptyState("没有符合条件的对话。", {
            hint: state.query ? `关键词「${escapeHtml(state.query)}」没有命中，换个词试试。` : "放宽筛选条件再试。",
          }),
    }),
  );

  if (state.query) {
    body.push(
      notice(
        `正在检索「<strong>${escapeHtml(state.query)}</strong>」，匹配范围是问题 + 回答全文。引用标题不参与匹配，避免搜到来源名却在正文里找不到。`,
        "info",
      ),
    );
  }

  return layout({
    title: "对话档案",
    active: "conversations",
    system,
    body: `${pageHead({
      kicker: "观测",
      title: "对话档案",
      sub: "每一次真实提问、AI 回答与引用链接。按批次看口径，按问题做跨平台并排对照。",
    })}${body.join("")}`,
  });
}

export { PROVIDER_TONES };
