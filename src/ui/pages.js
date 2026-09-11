import {
  badge,
  bar,
  cmd,
  dataTable,
  kvList,
  layout,
  metric,
  metricGrid,
  notice,
  panel,
  runLink,
} from "./layout.js";
import {
  METRIC_HINTS,
  dateTime,
  errorCodeLabel,
  escapeHtml,
  num,
  pct,
  statusLabel,
  statusTone,
  truncate,
} from "./format.js";

function mentionTone(rate) {
  if (rate == null) return "";
  if (rate >= 0.5) return "ok";
  if (rate > 0) return "warn";
  return "bad";
}

function brandBadge(mentioned) {
  if (mentioned === true) return badge("已提及", "ok");
  if (mentioned === false) return badge("未提及", "muted");
  return badge("未检测", "muted");
}

function resetBadge(confirmed) {
  if (confirmed === true) return badge("已确认新会话", "ok");
  if (confirmed === false) return badge("未确认", "warn");
  return badge("—", "muted");
}

function citationCell(row) {
  const captured = Number(row.captured_citation_count ?? 0);
  const expected = row.expected_citation_count;
  const text = expected == null ? `${captured}` : `${captured} / ${expected}`;
  const tone = expected == null ? "" : captured === Number(expected) ? "ok" : "warn";
  return tone ? badge(text, tone) : escapeHtml(text);
}

/* ------------------------------------------------------------------ 总览 */

export function homePage({ db, overview, batches, projects, localRuns, localRunCount }) {
  const blocks = [];

  if (!db.ready) {
    blocks.push(
      notice(
        `未连接 PostgreSQL（${escapeHtml(db.message ?? "未知原因")}），当前仅展示本地产物。` +
          `配置 <code>DATABASE_URL</code> 后可看到抽样批次与品牌提及率。`,
        "warn",
      ),
    );
  }

  blocks.push(
    metricGrid([
      metric({ label: "项目", value: num(overview.projects) }),
      metric({ label: "关键词池 Prompt", value: num(overview.prompts) }),
      metric({ label: "抽样批次", value: num(overview.batches) }),
      metric({ label: "运行总数", value: num(overview.runs) }),
      metric({ label: "唯一文章", value: num(overview.articles) }),
      metric({ label: "可见引用", value: num(overview.citations) }),
    ]),
  );

  if (batches.length) {
    blocks.push(
      panel("最近的抽样批次", {
        hint: "批次是主要分析单位，点击进入完整报告",
        body: dataTable({
          columns: [
            { label: "批次", render: (row) => `<a href="/batches/${row.id}">#${row.id} ${escapeHtml(truncate(row.name, 30))}</a>` },
            { label: "项目", render: (row) => escapeHtml(row.project_name) },
            { label: "目标品牌", render: (row) => escapeHtml(row.target_brand ?? "—") },
            { label: "状态", render: (row) => badge(statusLabel(row.status), statusTone(row.status)) },
            { label: "有效/总数", align: "right", render: (row) => `${num(row.valid_runs)} / ${num(row.runs_total)}` },
            {
              label: "RUN 提及率",
              align: "right",
              render: (row) =>
                `${escapeHtml(pct(row.mentioned_runs, row.valid_runs))} ${bar(row.mentioned_runs, row.valid_runs, mentionTone(row.valid_runs ? row.mentioned_runs / row.valid_runs : null))}`,
            },
            {
              label: "PROMPT 覆盖",
              align: "right",
              render: (row) => escapeHtml(pct(row.prompts_mentioned, row.prompts_total)),
            },
            { label: "引用", align: "right", render: (row) => num(row.citations) },
            {
              label: "目标文章命中",
              align: "right",
              render: (row) => `${num(row.tracked_cited)} / ${num(row.tracked_total)}`,
            },
            { label: "创建时间", className: "nowrap", render: (row) => dateTime(row.created_at) },
          ],
          rows: batches,
          empty: "还没有抽样批次。先导入关键词池，再执行 npm run sample。",
        }),
      }),
    );
  } else {
    blocks.push(
      panel("开始一次抽样", {
        body: `<div class="panel-body padded">
          <p class="lead" style="margin-bottom:10px">还没有抽样批次。三步即可跑完一次可见度测量：</p>
          ${cmd("npm run project:init -- --file examples/project.xiaomi.json", "1. 导入项目、关键词池、账号与目标文章")}
          ${cmd('npm run sample -- --project "小米汽车" --size 100 --method stratified --accounts account_01', "2. 随机抽取 Prompt 并分配账号")}
          ${cmd("npm run batch:run -- --batch <批次ID>", "3. 逐条真实提问并写入数据库")}
        </div>`,
      }),
    );
  }

  if (projects.length) {
    blocks.push(
      panel("项目", {
        body: dataTable({
          columns: [
            { label: "项目", render: (row) => `<a href="/projects/${row.id}">${escapeHtml(row.name)}</a>` },
            { label: "目标品牌", render: (row) => escapeHtml(row.target_brand ?? "—") },
            { label: "关键词池", align: "right", render: (row) => num(row.pool_size) },
            { label: "批次", align: "right", render: (row) => num(row.batch_count) },
            { label: "运行", align: "right", render: (row) => num(row.run_count) },
            { label: "引用", align: "right", render: (row) => num(row.citation_count) },
            { label: "监控文章", align: "right", render: (row) => num(row.tracked_count) },
          ],
          rows: projects,
        }),
      }),
    );
  }

  if (!db.ready && localRuns.length) {
    blocks.push(
      panel(`本地运行产物（最近 ${localRuns.length} / 共 ${num(localRunCount)} 条）`, {
        body: dataTable({
          columns: [
            { label: "运行", render: (row) => runLink(row.id) },
            { label: "状态", render: (row) => badge(statusLabel(row.status), statusTone(row.status)) },
            { label: "引用", align: "right", render: (row) => `${num((row.citations || []).length)} / ${row.expectedCitationCount ?? "—"}` },
            { label: "问题", render: (row) => escapeHtml(truncate(row.prompt, 60)) },
            { label: "错误", render: (row) => (row.errorCode ? badge(errorCodeLabel(row.errorCode), "bad") : "—") },
          ],
          rows: localRuns,
        }),
      }),
    );
  }

  return layout({
    title: "总览",
    active: "home",
    dbState: db.ready ? "数据库已连接" : "数据库未连接",
    body: `<h1>总览</h1>
<p class="lead">监控目标品牌在豆包回答中的提及率，以及品牌相关文章进入豆包可见引用源的情况。</p>
${blocks.join("")}`,
  });
}

/* ------------------------------------------------------------------ 批次列表 */

export function batchesPage({ db, batches, projects, projectId }) {
  const body = [];

  if (!db.ready) {
    return layout({
      title: "抽样批次",
      active: "batches",
      dbState: "数据库未连接",
      body: `<h1>抽样批次</h1>${notice(`未连接 PostgreSQL（${escapeHtml(db.message ?? "")}），无法读取批次。`, "warn")}`,
    });
  }

  body.push(
    `<p class="lead">每个批次代表一次完整实验：从关键词池按 seed 抽取 Prompt，分配账号，逐条真实提问。</p>`,
  );

  if (projects.length > 1) {
    const items = [{ href: "/batches", label: "全部项目", active: projectId == null }].concat(
      projects.map((project) => ({
        href: `/batches?project=${project.id}`,
        label: project.name,
        active: Number(projectId) === Number(project.id),
      })),
    );
    body.push(
      `<div class="filters">${items
        .map(
          (item) =>
            `<a href="${item.href}"${item.active ? ' class="active"' : ""}>${escapeHtml(item.label)}</a>`,
        )
        .join("")}</div>`,
    );
  }

  body.push(
    panel(`批次（${batches.length}）`, {
      body: dataTable({
        columns: [
          { label: "批次", render: (row) => `<a href="/batches/${row.id}">#${row.id} ${escapeHtml(truncate(row.name, 36))}</a>` },
          { label: "项目", render: (row) => escapeHtml(row.project_name) },
          { label: "状态", render: (row) => badge(statusLabel(row.status), statusTone(row.status)) },
          {
            label: "抽样",
            className: "mono",
            render: (row) =>
              escapeHtml(`${row.sampling_method === "stratified" ? "分层" : "纯随机"} ${row.sample_size}/${row.pool_size}`),
          },
          { label: "账号", render: (row) => escapeHtml((row.account_keys ?? []).join(", ") || "—") },
          { label: "有效/总数", align: "right", render: (row) => `${num(row.valid_runs)} / ${num(row.runs_total)}` },
          {
            label: "RUN 提及率",
            align: "right",
            render: (row) => escapeHtml(pct(row.mentioned_runs, row.valid_runs)),
          },
          {
            label: "PROMPT 覆盖",
            align: "right",
            render: (row) => escapeHtml(pct(row.prompts_mentioned, row.prompts_total)),
          },
          { label: "引用", align: "right", render: (row) => num(row.citations) },
          { label: "目标文章", align: "right", render: (row) => `${num(row.tracked_cited)} / ${num(row.tracked_total)}` },
          { label: "创建时间", className: "nowrap", render: (row) => dateTime(row.created_at) },
        ],
        rows: batches,
        empty: "该范围内还没有批次。",
      }),
    }),
  );

  return layout({
    title: "抽样批次",
    active: "batches",
    dbState: "数据库已连接",
    body: `<h1>抽样批次</h1>${body.join("")}`,
  });
}

/* ------------------------------------------------------------------ 批次详情 */

/**
 * 后台执行面板：进度、开始/停止按钮与轮询脚本。
 *
 * 不引入 WebSocket —— 批次处于执行中时每 4 秒拉一次进度接口，刷新数字后原地更新；
 * 批次进入终态时整页刷新一次，让报告区块也跟着更新。
 */
function executionPanel(batch, progress, queueReady) {
  const counts = progress?.counts ?? {
    requested: Number(batch.requested_jobs ?? 0),
    completed: Number(batch.completed_jobs ?? 0),
    failed: Number(batch.failed_jobs ?? 0),
    skipped: Number(batch.skipped_jobs ?? 0),
    waiting: 0,
    active: 0,
    done: Number(batch.completed_jobs ?? 0) + Number(batch.failed_jobs ?? 0) + Number(batch.skipped_jobs ?? 0),
    percent: 0,
  };
  const isActive = ["queued", "running"].includes(batch.status);
  const terminal = ["completed", "partial", "failed", "aborted"].includes(batch.status);

  const controls = [];
  if (!queueReady) {
    controls.push(
      `<span class="hint">未配置 <code>REDIS_URL</code>，后台队列不可用。可改用命令行：<code>npm run batch:run -- --batch ${batch.id}</code></span>`,
    );
  } else if (isActive) {
    controls.push(`<form class="inline-form" method="post" action="/batches/${batch.id}/stop"
        onsubmit="return confirm('确认停止监测？已完成的运行会保留，排队中的任务会被取消。');">
      <button class="ghost danger" type="submit">停止监测</button></form>`);
  } else {
    controls.push(`<form class="inline-form" method="post" action="/batches/${batch.id}/start">
      <button type="submit">${terminal ? "重新开始监测" : "开始监测"}</button></form>`);
  }

  const rows = [
    ["总任务数", counts.requested, "p-requested"],
    ["已完成", counts.done, "p-done"],
    ["运行中", counts.active, "p-active"],
    ["排队中", counts.waiting, "p-waiting"],
    ["成功 / 部分成功", counts.completed, "p-completed"],
    ["失败", counts.failed, "p-failed"],
    ["跳过（账号暂停或人工停止）", counts.skipped, "p-skipped"],
    ["进度", `${counts.percent}%`, "p-percent"],
  ];

  const table = `<table><tbody>${rows
    .map(
      ([label, value, id]) =>
        `<tr><th style="width:220px">${escapeHtml(label)}</th><td id="${id}">${escapeHtml(String(value))}</td></tr>`,
    )
    .join("")}</tbody></table>`;

  const poller = isActive
    ? `<script>
(function () {
  const batchId = ${batch.id};
  const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
  async function tick() {
    try {
      const res = await fetch("/api/batches/" + batchId + "/progress", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        const c = data.counts;
        set("p-requested", c.requested); set("p-done", c.done); set("p-active", c.active);
        set("p-waiting", c.waiting); set("p-completed", c.completed); set("p-failed", c.failed);
        set("p-skipped", c.skipped); set("p-percent", c.percent + "%");
        const bar = document.getElementById("p-bar");
        if (bar) bar.style.width = c.percent + "%";
        const status = document.getElementById("p-status");
        if (status) status.textContent = data.statusLabel;
        if (!data.active) { window.location.reload(); return; }
      }
    } catch (error) { /* 瞬时失败不打断轮询 */ }
    setTimeout(tick, 4000);
  }
  setTimeout(tick, 3000);
})();
</script>`
    : "";

  return panel("后台执行", {
    hint: isActive ? "执行中，页面每 4 秒刷新一次进度" : "由 Worker 独立进程执行，不会占用 Web 进程",
    body: `<div class="panel-body padded">
      <div class="grid" style="margin-bottom:14px">
        <div class="metric"><div class="label">当前状态</div>
          <div class="value" id="p-status" style="font-size:18px">${escapeHtml(statusLabel(batch.status))}</div>
          <div class="hint">${escapeHtml(batch.queued_at ? `入队于 ${dateTime(batch.queued_at)}` : "尚未入队")}</div>
        </div>
        <div class="metric"><div class="label">完成进度</div>
          <div class="value" id="p-percent">${escapeHtml(`${counts.percent}%`)}</div>
          <div class="bar" style="margin-top:8px"><span id="p-bar" style="width:${counts.percent}%"></span></div>
        </div>
      </div>
      ${table}
      <div class="actions" style="margin-top:14px">${controls.join("")}</div>
    </div>`,
  }) + poller;
}

export function batchPage({ report, runs, sources, progress, queueReady }) {
  const { batch, runs: runStats, prompts, citations, tracked } = report;

  const header = metricGrid([
    metric({
      label: "有效 Run",
      value: `${num(runStats.valid)} / ${num(runStats.assignmentsRun)}`,
      hint: METRIC_HINTS.validRuns,
      tone: runStats.valid === runStats.assignmentsRun ? "ok" : "warn",
    }),
    metric({
      label: "RUN 级品牌提及率",
      value: pct(runStats.mentioned, runStats.valid),
      hint: `${METRIC_HINTS.runMentionRate}（${num(runStats.mentioned)}/${num(runStats.valid)}）`,
      tone: mentionTone(runStats.valid ? runStats.mentioned / runStats.valid : null),
    }),
    metric({
      label: "PROMPT 级提及覆盖",
      value: pct(prompts.mentioned, prompts.total),
      hint: `${METRIC_HINTS.promptCoverage}（${num(prompts.mentioned)}/${num(prompts.total)}）`,
      tone: mentionTone(prompts.total ? prompts.mentioned / prompts.total : null),
    }),
    metric({
      label: "目标文章被引用",
      value: `${num(tracked.cited)} / ${num(tracked.total)}`,
      hint: `${METRIC_HINTS.trackedRate}（${pct(tracked.cited, tracked.total)}）`,
      tone: tracked.cited > 0 ? "ok" : "muted",
    }),
    metric({
      label: "可见引用",
      value: num(citations.total),
      hint: `${num(citations.articles)} 篇唯一文章 / ${num(citations.domains)} 个域名`,
    }),
    metric({
      label: "失败 Run",
      value: num(runStats.failed),
      hint: runStats.partial ? `另有 ${num(runStats.partial)} 条部分成功（${METRIC_HINTS.partial}）` : "无",
      tone: runStats.failed ? "bad" : "ok",
    }),
  ]);

  // 样本口径必须单列：请求数与有效数不一致时，绝不能让报告读起来像「基于请求数」。
  const sampleCounts = progress?.counts ?? {
    requested: runStats.assignmentsRun,
    completed: runStats.valid,
    failed: runStats.failed,
    skipped: 0,
  };
  const invalidSamples = Math.max(
    0,
    Number(sampleCounts.requested) - Number(sampleCounts.completed),
  );

  const sampling = kvList([
    ["项目", escapeHtml(batch.project_name)],
    ["目标品牌", escapeHtml(batch.target_brand ?? "未配置")],
    ["批次名称", escapeHtml(batch.name)],
    ["状态", badge(statusLabel(batch.status), statusTone(batch.status))],
    ["抽样方式", batch.sampling_method === "stratified" ? "分层抽样（按分类按比例）" : "纯随机抽样"],
    ["抽样种子", `<code>${escapeHtml(batch.sampling_seed)}</code>`],
    ["池大小 / 抽样数", `${num(batch.pool_size)} / ${num(batch.sample_size)}（每 Prompt 重复 ${num(batch.repeats)} 次）`],
    ["关键词池版本", escapeHtml(batch.pool_version ?? "—")],
    ["账号", escapeHtml((batch.account_keys ?? []).join(", ") || "—")],
    ["开始 / 结束", `${dateTime(batch.started_at)} → ${dateTime(batch.finished_at)}`],
  ]);

  const blocks = [
    `<h1>批次 #${batch.id}</h1>`,
    `<p class="lead">${escapeHtml(batch.name)} · 目标品牌 ${escapeHtml(batch.target_brand ?? "未配置")}</p>`,
    header,
    executionPanel(batch, progress, queueReady),
    panel("样本口径", {
      hint: "核心指标的分母只使用有效样本，请求数不等于样本数",
      body: dataTable({
        columns: [
          { label: "口径", render: (row) => escapeHtml(row.label) },
          { label: "数量", align: "right", render: (row) => num(row.value) },
          { label: "占比", align: "right", render: (row) => escapeHtml(pct(row.value, sampleCounts.requested)) },
          { label: "说明", render: (row) => escapeHtml(row.hint) },
        ],
        rows: [
          { label: "Requested Samples 请求样本", value: sampleCounts.requested, hint: "该批次总共安排的分配数" },
          {
            label: "Valid Samples 有效样本",
            value: sampleCounts.completed,
            hint: "成功/部分成功，且已确认从空会话开始",
          },
          {
            label: "Invalid / Failed 无效样本",
            value: invalidSamples,
            hint: "失败、未确认新会话、空回答，以及因账号暂停而跳过的分配",
          },
          { label: "其中失败 Run", value: sampleCounts.failed, hint: "真正执行过但失败了" },
          { label: "其中跳过", value: sampleCounts.skipped, hint: "未执行：账号被暂停，或人工停止批次" },
        ],
      }),
    }),
    panel("抽样参数", {
      hint: "同一种子可完整复现本次抽样",
      body: sampling,
      actions: `<span style="margin-left:auto"></span>`,
    }),
    panel(`目标文章监控（${num(tracked.cited)} / ${num(tracked.total)} 被引用）`, {
      hint: "canonical URL 精确匹配",
      body: dataTable({
        columns: [
          {
            label: "文章",
            render: (row) =>
              `${escapeHtml(truncate(row.title || row.canonical_url, 52))}<div class="hint mono">${escapeHtml(truncate(row.canonical_url, 70))}</div>`,
          },
          { label: "域名", render: (row) => escapeHtml(row.domain ?? "—") },
          { label: "被引用", align: "right", render: (row) => num(row.citations) },
          { label: "涉及问题", align: "right", render: (row) => num(row.prompts) },
          { label: "账号数", align: "right", render: (row) => num(row.accounts) },
          { label: "首次", className: "nowrap", render: (row) => dateTime(row.first_seen_at) },
          { label: "最近", className: "nowrap", render: (row) => dateTime(row.last_seen_at) },
        ],
        rows: tracked.articles,
        empty: "该项目还没有配置监控文章。",
      }),
    }),
  ];

  if (report.byCategory.length) {
    blocks.push(
      panel("按问题分类拆分", {
        hint: "不同意图类别下的品牌提及差异",
        body: dataTable({
          columns: [
            { label: "分类", render: (row) => escapeHtml(row.category) },
            { label: "有效 Run", align: "right", render: (row) => num(row.validRuns) },
            { label: "提及", align: "right", render: (row) => num(row.mentioned) },
            {
              label: "提及率",
              align: "right",
              render: (row) =>
                `${escapeHtml(pct(row.mentioned, row.validRuns))} ${bar(row.mentioned, row.validRuns, mentionTone(row.mentionRate))}`,
            },
          ],
          rows: report.byCategory,
        }),
      }),
    );
  }

  if (report.byAccount.length) {
    blocks.push(
      panel("按账号拆分", {
        hint: "多账号用于观察个性化差异；当前为单账号开发阶段",
        body: dataTable({
          columns: [
            { label: "账号", render: (row) => `<code>${escapeHtml(row.account)}</code>` },
            { label: "有效 Run", align: "right", render: (row) => num(row.validRuns) },
            { label: "提及", align: "right", render: (row) => num(row.mentioned) },
            { label: "提及率", align: "right", render: (row) => escapeHtml(pct(row.mentioned, row.validRuns)) },
            { label: "去重问题", align: "right", render: (row) => num(row.prompts) },
            { label: "引用", align: "right", render: (row) => num(row.citations) },
          ],
          rows: report.byAccount,
        }),
      }),
    );
  }

  blocks.push(
    panel("批次内运行明细", {
      hint: `${num(runs.length)} 条`,
      body: dataTable({
        columns: [
          { label: "运行", render: (row) => runLink(row.local_run_id, truncate(row.local_run_id, 26)) },
          { label: "分类", render: (row) => escapeHtml(row.category ?? "—") },
          { label: "账号", render: (row) => `<code>${escapeHtml(row.account_key ?? "—")}</code>` },
          { label: "状态", render: (row) => badge(statusLabel(row.status), statusTone(row.status)) },
          { label: "新会话", render: (row) => resetBadge(row.conversation_reset_confirmed) },
          { label: "品牌", render: (row) => brandBadge(row.brand_mentioned) },
          { label: "提及次数", align: "right", render: (row) => (row.mention_count == null ? "—" : num(row.mention_count)) },
          { label: "引用", align: "right", render: (row) => citationCell(row) },
          { label: "问题", render: (row) => escapeHtml(truncate(row.prompt, 46)) },
          { label: "错误", render: (row) => (row.error_code ? badge(errorCodeLabel(row.error_code), "bad") : "—") },
        ],
        rows: runs,
        empty: "该批次还没有运行记录。",
      }),
    }),
  );

  if (report.failures.length) {
    blocks.push(
      panel("失败原因", {
        body: dataTable({
          columns: [
            { label: "错误", render: (row) => escapeHtml(errorCodeLabel(row.error_code)) },
            { label: "运行数", align: "right", render: (row) => num(row.runs) },
          ],
          rows: report.failures,
        }),
      }),
    );
  }

  blocks.push(
    panel("该批次引用最多的域名", {
      body: dataTable({
        columns: [
          { label: "域名", render: (row) => escapeHtml(row.domain) },
          { label: "引用", align: "right", render: (row) => num(row.citations) },
          { label: "文章", align: "right", render: (row) => num(row.articles) },
          { label: "占比", align: "right", render: (row) => escapeHtml(pct(row.citations, sources.totals.citations)) },
        ],
        rows: sources.domains,
        empty: "该批次没有抓到引用。",
      }),
    }),
    panel("该批次引用最多的文章", {
      body: dataTable({
        columns: [
          {
            label: "文章",
            render: (row) =>
              `<a href="${escapeHtml(row.canonical_url)}" target="_blank" rel="noreferrer">${escapeHtml(truncate(row.title || row.canonical_url, 58))}</a>
               ${row.is_tracked ? badge("监控中", "info") : ""}`,
          },
          { label: "域名", render: (row) => escapeHtml(row.normalized_domain ?? row.domain) },
          { label: "引用", align: "right", render: (row) => num(row.citations) },
          { label: "问题数", align: "right", render: (row) => num(row.prompts) },
        ],
        rows: sources.articles,
        empty: "该批次没有抓到引用。",
      }),
    }),
    panel("后续操作", {
      body: `<div class="panel-body padded">
        ${cmd(`npm run batch:run -- --batch ${batch.id}`, "重新执行剩余/全部分配（已完成的会被覆盖为最新结果）")}
        ${cmd(`npm run report -- --batch ${batch.id}`, "在终端输出同一份报告")}
        ${cmd(
          `npm run sample -- --project "${batch.project_name}" --size ${batch.sample_size} --method ${batch.sampling_method} --seed ${batch.sampling_seed} --accounts ${(batch.account_keys ?? ["account_01"]).join(",")}`,
          "用同一种子复现这次抽样",
        )}
      </div>`,
    }),
  );

  return layout({
    title: `批次 #${batch.id}`,
    active: "batches",
    dbState: "数据库已连接",
    body: blocks.join(""),
  });
}

/* ------------------------------------------------------------------ 运行列表 */

export function runsPage({ db, runs, projects, localRuns, filters: filterState }) {
  const body = [];

  if (!db.ready) {
    body.push(
      notice(
        `未连接 PostgreSQL（${escapeHtml(db.message ?? "")}），下面展示的是本地运行产物。`,
        "warn",
      ),
    );
    body.push(
      panel(`本地运行产物（${localRuns.length}）`, {
        body: dataTable({
          columns: [
            { label: "运行", render: (row) => runLink(row.id, truncate(row.id, 30)) },
            { label: "项目", render: (row) => escapeHtml(row.project ?? "—") },
            { label: "状态", render: (row) => badge(statusLabel(row.status), statusTone(row.status)) },
            { label: "引用", align: "right", render: (row) => `${num((row.citations || []).length)} / ${row.expectedCitationCount ?? "—"}` },
            { label: "问题", render: (row) => escapeHtml(truncate(row.prompt, 54)) },
            { label: "错误", render: (row) => (row.errorCode ? badge(errorCodeLabel(row.errorCode), "bad") : "—") },
          ],
          rows: localRuns,
        }),
      }),
    );
    return layout({
      title: "运行记录",
      active: "runs",
      dbState: "数据库未连接",
      body: `<h1>运行记录</h1>${body.join("")}`,
    });
  }

  const statusFilters = [
    { href: "/runs", label: "全部", active: !filterState.status },
    { href: "/runs?status=success", label: "成功", active: filterState.status === "success" },
    { href: "/runs?status=partial", label: "部分成功", active: filterState.status === "partial" },
    { href: "/runs?status=failed", label: "失败", active: filterState.status === "failed" },
  ];

  if (projects.length > 1) {
    for (const project of projects) {
      statusFilters.push({
        href: `/runs?project=${project.id}${filterState.status ? `&status=${filterState.status}` : ""}`,
        label: project.name,
        active: Number(filterState.projectId) === Number(project.id),
      });
    }
  }

  body.push(
    `<div class="filters">${statusFilters
      .map(
        (item) =>
          `<a href="${item.href}"${item.active ? ' class="active"' : ""}>${escapeHtml(item.label)}</a>`,
      )
      .join("")}</div>`,
  );

  body.push(
    panel(`运行记录（${num(runs.length)}）`, {
      body: dataTable({
        columns: [
          { label: "运行", render: (row) => runLink(row.local_run_id, truncate(row.local_run_id, 26)) },
          { label: "项目", render: (row) => escapeHtml(row.project_name) },
          { label: "批次", render: (row) => (row.sampling_batch_id ? `<a href="/batches/${row.sampling_batch_id}">#${row.sampling_batch_id}</a>` : "—") },
          { label: "分类", render: (row) => escapeHtml(row.category ?? "—") },
          { label: "状态", render: (row) => badge(statusLabel(row.status), statusTone(row.status)) },
          { label: "新会话", render: (row) => resetBadge(row.conversation_reset_confirmed) },
          { label: "品牌", render: (row) => brandBadge(row.brand_mentioned) },
          { label: "引用", align: "right", render: (row) => citationCell(row) },
          { label: "问题", render: (row) => escapeHtml(truncate(row.prompt, 42)) },
          { label: "时间", className: "nowrap", render: (row) => dateTime(row.started_at) },
        ],
        rows: runs,
        empty: "没有符合条件的运行记录。",
      }),
    }),
  );

  return layout({
    title: "运行记录",
    active: "runs",
    dbState: "数据库已连接",
    body: `<h1>运行记录</h1>
<p class="lead">每一次向豆包发出的真实提问。只有「已确认新会话」的成功/部分成功运行才进入品牌提及率统计。</p>
${body.join("")}`,
  });
}

/* ------------------------------------------------------------------ 运行详情 */

export function runPage({ db, run, citations, localRun, runId }) {
  if (!run && !localRun) {
    return layout({
      title: "运行不存在",
      active: "runs",
      body: `<h1>运行不存在</h1><p class="lead">找不到 ${escapeHtml(runId)}。</p><p><a href="/runs">返回运行记录</a></p>`,
    });
  }

  const source = run ?? localRun;
  const blocks = [];

  blocks.push(`<h1>${escapeHtml(runId)}</h1>`);
  blocks.push(
    `<p class="lead">${
      run
        ? `项目 ${escapeHtml(run.project_name)}${run.batch_name ? ` · 批次 ${escapeHtml(run.batch_name)}` : ""}`
        : "本地产物（未写入数据库）"
    }</p>`,
  );

  const captured = run ? Number(run.captured_citation_count) : (localRun.citations || []).length;
  const expected = run ? run.expected_citation_count : localRun.expectedCitationCount;

  blocks.push(
    metricGrid([
      metric({
        label: "状态",
        value: statusLabel(source.status),
        tone: statusTone(source.status),
        hint: source.error_code ? errorCodeLabel(source.error_code) : "无错误",
      }),
      metric({
        label: "品牌提及",
        value: run ? (run.brand_mentioned === true ? "已提及" : run.brand_mentioned === false ? "未提及" : "未检测") : "—",
        hint: run?.mention_count != null ? `出现 ${num(run.mention_count)} 次` : "该项目未配置目标品牌",
        tone: run?.brand_mentioned === true ? "ok" : "",
      }),
      metric({
        label: "可见引用",
        value: expected == null ? num(captured) : `${num(captured)} / ${num(expected)}`,
        hint: "抓取数 / 页面标注数",
        tone: expected == null ? "" : captured === Number(expected) ? "ok" : "warn",
      }),
      metric({
        label: "新会话确认",
        value: source.conversation_reset_confirmed === true ? "已确认" : "未确认",
        hint: "只有确认从空会话开始的运行才计入统计",
        tone: source.conversation_reset_confirmed === true ? "ok" : "warn",
      }),
    ]),
  );

  if (source.error_code) {
    blocks.push(
      notice(
        `<strong>${escapeHtml(errorCodeLabel(source.error_code))}</strong><br>${escapeHtml(
          source.error_message ?? localRun?.errorMessage ?? "",
        )}`,
        "bad",
      ),
    );
  }

  const meta = [];
  if (run) {
    meta.push(["项目", escapeHtml(run.project_name)]);
    meta.push(["批次", run.sampling_batch_id ? `<a href="/batches/${run.sampling_batch_id}">#${run.sampling_batch_id}</a>` : "—"]);
    meta.push(["账号", `<code>${escapeHtml(run.account_key ?? "—")}</code>`]);
    meta.push(["服务方", escapeHtml(run.provider)]);
    meta.push(["引用状态", escapeHtml(run.citation_state ?? "—")]);
    meta.push(["提交方式", run.submission_method === "send_button" ? "发送按钮" : run.submission_method === "enter_key" ? "回车键" : "—"]);
    meta.push(["开始 / 结束", `${dateTime(run.started_at)} → ${dateTime(run.finished_at)}`]);
  } else {
    meta.push(["项目", escapeHtml(localRun.project ?? "—")]);
    meta.push(["账号", `<code>${escapeHtml(localRun.accountKey ?? "—")}</code>`]);
    meta.push(["开始 / 结束", `${dateTime(localRun.startedAt)} → ${dateTime(localRun.completedAt)}`]);
  }
  meta.push(["调试产物", `<code>${escapeHtml(localRun?.debugPath ?? (run?.artifact_path ?? "—"))}</code>`]);

  blocks.push(panel("运行信息", { body: kvList(meta) }));

  if (run?.matched_terms?.length) {
    blocks.push(
      panel("品牌命中词", {
        hint: "规则检测结果，位置为回答内的字符偏移",
        body: dataTable({
          columns: [
            { label: "命中词", render: (row) => `<span class="term">${escapeHtml(row.term)}</span>` },
            { label: "类型", render: (row) => badge(row.kind === "product" ? "产品名" : "品牌别名", row.kind === "product" ? "info" : "") },
            { label: "次数", align: "right", render: (row) => num(row.count) },
            { label: "首次位置", align: "right", render: (row) => num(row.firstPosition) },
          ],
          rows: run.matched_terms,
        }),
      }),
    );
  }

  blocks.push(
    panel("回答", {
      body: `<div class="panel-body padded">
        <h3>提问</h3>
        <pre>${escapeHtml(source.prompt ?? run?.prompt ?? "")}</pre>
        <h3>回答</h3>
        <pre>${escapeHtml(run?.answer ?? localRun?.answer ?? "（未抓到回答）")}</pre>
      </div>`,
    }),
  );

  const citationRows = citations ?? [];
  blocks.push(
    panel(`可见引用（${num(citationRows.length)})`, {
      hint: "仅包含豆包界面中对用户可见的来源",
      body: dataTable({
        columns: [
          { label: "#", align: "right", render: (row) => num(row.source_position) },
          {
            label: "文章",
            render: (row) =>
              row.original_url
                ? `<a href="${escapeHtml(row.original_url)}" target="_blank" rel="noreferrer">${escapeHtml(truncate(row.title || row.original_url, 56))}</a>${row.tracked_article_id ? ` ${badge("监控中", "info")}` : ""}`
                : escapeHtml(row.title ?? "—"),
          },
          { label: "域名", render: (row) => escapeHtml(row.normalized_domain ?? row.domain ?? "—") },
          { label: "关联状态", render: (row) => badge(row.relation_status === "matched" ? "已匹配正文" : "未匹配", row.relation_status === "matched" ? "ok" : "muted") },
          { label: "来源", render: (row) => escapeHtml(row.captured_from ?? "DOM") },
        ],
        rows: citationRows,
        empty: "该次运行没有可见引用。",
      }),
    }),
  );

  if (localRun) {
    blocks.push(
      panel("本地调试产物", {
        hint: "数据库只保存结构化数据，截图与 HTML 快照保留在本地",
        body: `<div class="panel-body padded">
          <img class="shot" src="/artifacts/${encodeURIComponent(runId)}/screenshot.png" alt="运行截图" />
        </div>`,
      }),
    );
  }

  return layout({
    title: truncate(runId, 30),
    active: "runs",
    dbState: db.ready ? "数据库已连接" : "数据库未连接",
    body: blocks.join(""),
  });
}

/* ------------------------------------------------------------------ 引用来源 */

export function sourcesPage({ db, sources, projects, projectId }) {
  if (!db.ready) {
    return layout({
      title: "引用来源",
      active: "sources",
      dbState: "数据库未连接",
      body: `<h1>引用来源</h1>${notice(`未连接 PostgreSQL（${escapeHtml(db.message ?? "")}），无法聚合引用来源。`, "warn")}`,
    });
  }

  const body = [
    `<p class="lead">只统计在豆包界面对用户可见的来源，不把搜索请求、训练数据或后台检索结果当成引用。</p>`,
    metricGrid([
      metric({ label: "可见引用", value: num(sources.totals.citations) }),
      metric({ label: "唯一文章", value: num(sources.totals.articles) }),
      metric({ label: "唯一域名", value: num(sources.totals.domains) }),
    ]),
  ];

  body.push(
    panel("域名分布", {
      body: dataTable({
        columns: [
          { label: "域名", render: (row) => escapeHtml(row.domain) },
          { label: "引用", align: "right", render: (row) => num(row.citations) },
          { label: "文章", align: "right", render: (row) => num(row.articles) },
          { label: "运行", align: "right", render: (row) => num(row.runs) },
          {
            label: "占比",
            align: "right",
            render: (row) => `${escapeHtml(pct(row.citations, sources.totals.citations))} ${bar(row.citations, sources.totals.citations)}`,
          },
        ],
        rows: sources.domains,
        empty: "还没有引用数据。",
      }),
    }),
    panel("被引用最多的文章", {
      body: dataTable({
        columns: [
          {
            label: "文章",
            render: (row) =>
              `<a href="${escapeHtml(row.canonical_url)}" target="_blank" rel="noreferrer">${escapeHtml(truncate(row.title || row.canonical_url, 60))}</a>${row.is_tracked ? ` ${badge("监控中", "info")}` : ""}`,
          },
          { label: "域名", render: (row) => escapeHtml(row.normalized_domain ?? row.domain) },
          { label: "引用", align: "right", render: (row) => num(row.citations) },
          { label: "涉及问题", align: "right", render: (row) => num(row.prompts) },
        ],
        rows: sources.articles,
        empty: "还没有引用数据。",
      }),
    }),
  );

  return layout({
    title: "引用来源",
    active: "sources",
    dbState: "数据库已连接",
    body: `<h1>引用来源</h1>${body.join("")}`,
  });
}

/* ------------------------------------------------------------------ 项目 */

/* ------------------------------------------------------------------ 项目列表 */

export function projectsPage({ db, projects, notice: noticeMessage = null }) {
  if (!db.ready) {
    return layout({
      title: "项目配置",
      active: "projects",
      dbState: "数据库未连接",
      body: `<h1>项目配置</h1>${notice(`未连接 PostgreSQL（${escapeHtml(db.message ?? "")}）。`, "warn")}`,
    });
  }

  return layout({
    title: "项目配置",
    active: "projects",
    dbState: "数据库已连接",
    body: `<h1>项目配置</h1>
<p class="lead">每个项目拥有完全独立的关键词池，抽样只会从当前项目自己启用的关键词中抽取，项目之间不会互相影响。</p>
${noticeMessage ? notice(escapeHtml(noticeMessage)) : ""}
${panel("新建项目", {
  hint: "创建后在「关键词池」页面人工录入关键词",
  body: `<div class="panel-body padded">
    <form method="post" action="/projects" class="form-row">
      <div class="field grow"><label>项目名称</label>
        <input type="text" name="name" required maxlength="120" placeholder="例如：小米汽车" /></div>
      <div class="field grow"><label>目标品牌（可选，用于品牌提及检测）</label>
        <input type="text" name="targetBrand" maxlength="120" placeholder="例如：小米汽车" /></div>
      <div class="field grow"><label>说明（可选）</label>
        <input type="text" name="description" maxlength="300" placeholder="例如：监控小米汽车在豆包回答中的提及率" /></div>
      <button type="submit">新建项目</button>
    </form>
  </div>`,
})}
${panel(`项目（${projects.length}）`, {
  body: dataTable({
    columns: [
      { label: "项目", render: (row) => `<a href="/projects/${row.id}">${escapeHtml(row.name)}</a>` },
      { label: "目标品牌", render: (row) => escapeHtml(row.target_brand ?? "—") },
      {
        label: "关键词池（启用 / 总数）",
        align: "right",
        render: (row) => `${num(row.pool_enabled)} / ${num(row.pool_size)}`,
      },
      { label: "批次", align: "right", render: (row) => num(row.batch_count) },
      { label: "运行", align: "right", render: (row) => num(row.run_count) },
      { label: "引用", align: "right", render: (row) => num(row.citation_count) },
      { label: "监控文章", align: "right", render: (row) => num(row.tracked_count) },
      { label: "创建时间", className: "nowrap", render: (row) => dateTime(row.created_at) },
    ],
    rows: projects,
    empty: "还没有项目，用上面的表单新建一个。",
  }),
})}`,
  });
}

/* ------------------------------------------------------------------ 项目标签页 */

function projectTabs(projectId, active) {
  const items = [
    ["overview", "", "项目概览"],
    ["keywords", "/keywords", "关键词池"],
    ["sampling", "/sampling", "抽样"],
    ["runs", "/runs", "运行记录"],
    ["sources", "/sources", "引用来源"],
  ];
  return `<nav class="tabs">${items
    .map(
      ([key, suffix, label]) =>
        `<a href="/projects/${projectId}${suffix}"${active === key ? ' class="active"' : ""}>${escapeHtml(label)}</a>`,
    )
    .join("")}</nav>`;
}

function projectHeader(project, active, noticeMessage) {
  return `${projectTabs(project.id, active)}
<h1>${escapeHtml(project.name)}</h1>
<p class="lead">${escapeHtml(project.description ?? "（无描述）")}</p>
${noticeMessage ? notice(escapeHtml(noticeMessage)) : ""}`;
}

/* ------------------------------------------------------------------ 项目概览 */

export function projectOverviewPage({ project, pool, tracked, accounts, batches, keywordStats }) {
  const aliases =
    (project.brand_aliases ?? []).map((term) => `<span class="term">${escapeHtml(term)}</span>`).join(" ") || "—";
  const products =
    (project.brand_product_aliases ?? []).map((term) => `<span class="term">${escapeHtml(term)}</span>`).join(" ") || "—";
  const excludes =
    (project.brand_exclude_patterns ?? []).map((term) => `<code>${escapeHtml(term)}</code>`).join(" ") || "—";

  return layout({
    title: project.name,
    active: "projects",
    dbState: "数据库已连接",
    body: `${projectHeader(project, "overview", null)}
${metricGrid([
  metric({ label: "目标品牌", value: project.target_brand ?? "未配置", hint: "未配置则不做品牌提及判定" }),
  metric({
    label: "关键词池",
    value: num(keywordStats.enabled),
    hint: `启用 ${num(keywordStats.enabled)} / 未删除 ${num(keywordStats.total)}，已删除 ${num(keywordStats.deleted)}`,
  }),
  metric({ label: "抽样批次", value: num(batches.length), hint: "抽样只从本项目的关键词池抽取" }),
  metric({
    label: "监控文章",
    value: num(tracked.length),
    hint: `${tracked.filter((row) => Number(row.citations) > 0).length} 篇已被引用过`,
  }),
  metric({ label: "可用账号", value: num(accounts.length), hint: accounts.map((row) => row.account_key).join(", ") || "未配置" }),
])}
${panel("品牌识别规则", {
  hint: "第一阶段为规则检测，原始回答始终保留以便人工审计",
  body: kvList([
    ["品牌别名", aliases],
    ["产品名", products],
    ["排除模式", excludes],
    ["命中规则", "重叠时保留最长匹配；排除模式覆盖的区域先被抹除再匹配"],
    ["改动方式", "<code>npm run project:init -- --file &lt;配置文件&gt;</code> 或直接在数据库中调整"],
  ]),
})}
${panel(`关键词池分类（${num(pool.reduce((sum, row) => sum + Number(row.prompts), 0))} 条）`, {
  hint: "分层抽样按各分类占比按比例分配名额",
  body: dataTable({
    columns: [
      { label: "分类", render: (row) => escapeHtml(row.category) },
      { label: "关键词数", align: "right", render: (row) => num(row.prompts) },
      { label: "启用", align: "right", render: (row) => num(row.enabled) },
      { label: "池版本", render: (row) => escapeHtml(row.pool_version ?? "—") },
    ],
    rows: pool,
    empty: "关键词池为空，去「关键词池」页面录入。",
  }),
})}
${panel(`监控文章（${tracked.length}）`, {
  hint: "canonical URL 精确匹配；命中后可查看被哪些提问、哪些账号引用",
  body: dataTable({
    columns: [
      {
        label: "文章",
        render: (row) =>
          `<a href="${escapeHtml(row.canonical_url)}" target="_blank" rel="noreferrer">${escapeHtml(truncate(row.title || row.canonical_url, 56))}</a>
           <div class="hint mono">${escapeHtml(truncate(row.canonical_url, 72))}</div>`,
      },
      { label: "域名", render: (row) => escapeHtml(row.normalized_domain ?? row.domain ?? "—") },
      {
        label: "被引用",
        align: "right",
        render: (row) => (Number(row.citations) > 0 ? badge(num(row.citations), "ok") : badge("0", "muted")),
      },
      { label: "涉及运行", align: "right", render: (row) => num(row.runs) },
      { label: "首次", className: "nowrap", render: (row) => dateTime(row.first_seen_at) },
      { label: "最近", className: "nowrap", render: (row) => dateTime(row.last_seen_at) },
    ],
    rows: tracked,
    empty: "还没有配置监控文章。",
  }),
})}`,
  });
}

/* ------------------------------------------------------------------ 关键词池 */

function keywordStatus(keyword) {
  if (keyword.deleted_at) return badge("已删除", "bad");
  if (keyword.enabled) return badge("启用中", "ok");
  return badge("已禁用", "muted");
}

function keywordActions(projectId, keyword) {
  const base = `/projects/${projectId}/keywords/${keyword.id}`;
  if (keyword.deleted_at) {
    return `<form class="inline-form" method="post" action="${base}/restore">
      <button class="ghost" type="submit">恢复</button></form>`;
  }
  const nextEnabled = keyword.enabled ? "false" : "true";
  return `<div class="actions">
    <form class="inline-form" method="post" action="${base}/toggle">
      <input type="hidden" name="enabled" value="${nextEnabled}" />
      <button class="ghost" type="submit">${keyword.enabled ? "禁用" : "启用"}</button>
    </form>
    <form class="inline-form" method="post" action="${base}/delete"
          onsubmit="return confirm('确认删除这个关键词？历史运行记录与批次会保留。');">
      <button class="ghost danger" type="submit">删除</button>
    </form>
  </div>`;
}

export function projectKeywordsPage({ project, keywords, stats, notice: noticeMessage }) {
  const alive = keywords.filter((keyword) => !keyword.deleted_at);

  return layout({
    title: `${project.name} · 关键词池`,
    active: "projects",
    dbState: "数据库已连接",
    body: `${projectHeader(project, "keywords", noticeMessage)}
${metricGrid([
  metric({ label: "启用中", value: num(stats.enabled), hint: "只有启用中的关键词会被抽样" }),
  metric({ label: "未删除", value: num(stats.total) }),
  metric({ label: "已删除", value: num(stats.deleted), hint: "删除为软删除，历史记录不受影响" }),
])}
${panel("添加到关键词池", {
  hint: "人工录入，多个关键词用 # 分隔",
  body: `<div class="panel-body padded">
    <form method="post" action="/projects/${project.id}/keywords" class="form-block">
      <textarea name="input" required
        placeholder="输入搜索关键词，多个关键词用 # 分隔&#10;例如：20万新能源SUV推荐#国产新能源车哪个好#家庭第一辆电动车怎么选"></textarea>
      <div class="form-row">
        <div class="field grow"><label>分类（可选，用于分层抽样）</label>
          <input type="text" name="category" maxlength="60" placeholder="例如：购买推荐" /></div>
        <button type="submit">添加到关键词池</button>
      </div>
    </form>
    <details class="help"><summary>输入清洗规则</summary>
      <div>
        以 <code>#</code>（兼容全角 <code>＃</code> 与换行）分隔；每项去掉首尾空白；忽略空项；<br>
        同一项目内自动去重并保留首次出现顺序；中文标点原样保留，不改动关键词正文；<br>
        不同项目之间互不影响，同一个关键词可以在多个项目里各存在一条。
      </div>
    </details>
  </div>`,
})}
${panel(`关键词（共 ${num(alive.length)} 条，含已删除 ${num(keywords.length)} 条）`, {
  hint: "抽样只会使用「启用中」的关键词",
  body: dataTable({
    columns: [
      { label: "关键词", render: (row) => escapeHtml(row.prompt) },
      { label: "分类", render: (row) => escapeHtml(row.category ?? "—") },
      { label: "状态", render: (row) => keywordStatus(row) },
      { label: "来源", render: (row) => badge(row.source === "pool" ? "导入" : "录入", "muted") },
      {
        label: "被抽样",
        align: "right",
        render: (row) => (Number(row.run_count) > 0 ? `${num(row.run_count)} 次` : "—"),
      },
      { label: "创建时间", className: "nowrap", render: (row) => dateTime(row.created_at) },
      { label: "操作", render: (row) => keywordActions(project.id, row) },
    ],
    rows: keywords,
    empty: "还没有关键词，用上面的输入框添加。",
  }),
})}`,
  });
}

/* ------------------------------------------------------------------ 抽样 */

export function projectSamplingPage({ project, batches, accounts, stats, notice: noticeMessage }) {
  const accountList = accounts.map((row) => row.account_key).join(",");

  return layout({
    title: `${project.name} · 抽样`,
    active: "projects",
    dbState: "数据库已连接",
    body: `${projectHeader(project, "sampling", noticeMessage)}
${metricGrid([
  metric({ label: "可抽样关键词", value: num(stats.enabled), hint: "来自本项目的关键词池，已启用的部分" }),
  metric({ label: "历史批次", value: num(batches.length), hint: "批次保留当时抽中的关键词，不受后续改动影响" }),
])}
${panel("从本项目关键词池抽样", {
  hint: `当前可抽 ${num(stats.enabled)} 条`,
  body: `<div class="panel-body padded">
    <form method="post" action="/projects/${project.id}/sampling" class="form-row">
      <div class="field narrow"><label>抽样数量</label>
        <input type="number" name="size" min="1" max="${Math.max(1, Number(stats.enabled))}" value="${Math.min(20, Math.max(1, Number(stats.enabled)))}" required /></div>
      <div class="field"><label>抽样方式</label>
        <select name="method">
          <option value="stratified">分层抽样（按分类按比例）</option>
          <option value="random">纯随机抽样</option>
        </select></div>
      <div class="field grow"><label>账号（逗号分隔）</label>
        <input type="text" name="accounts" value="${escapeHtml(accountList || "account_01")}" required /></div>
      <div class="field narrow"><label>每问重复次数</label>
        <input type="number" name="repeats" min="1" value="1" /></div>
      <div class="field grow"><label>抽样种子（留空自动生成）</label>
        <input type="text" name="seed" placeholder="填写同一种子可复现本次抽样" /></div>
      <button type="submit">抽取并创建批次</button>
    </form>
    <details class="help"><summary>抽样与执行的分工</summary>
      <div>
        本页只负责「抽哪些关键词、分给哪个账号」，抽完立即落库并记录种子，过程很快。<br>
        真正向豆包提问耗时较长，仍通过命令行执行，批次页面会给出对应命令：<br>
        <code>npm run batch:run -- --batch &lt;批次ID&gt;</code>
      </div>
    </details>
  </div>`,
})}
${panel(`本项目批次（${batches.length}）`, {
  body: dataTable({
    columns: [
      { label: "批次", render: (row) => `<a href="/batches/${row.id}">#${row.id} ${escapeHtml(truncate(row.name, 30))}</a>` },
      { label: "状态", render: (row) => badge(statusLabel(row.status), statusTone(row.status)) },
      {
        label: "抽样",
        render: (row) =>
          escapeHtml(`${row.sampling_method === "stratified" ? "分层" : "纯随机"} ${row.sample_size}/${row.pool_size}`),
      },
      { label: "账号", render: (row) => escapeHtml((row.account_keys ?? []).join(", ") || "—") },
      { label: "种子", className: "mono", render: (row) => escapeHtml(row.sampling_seed) },
      { label: "有效/总数", align: "right", render: (row) => `${num(row.valid_runs)} / ${num(row.runs_total)}` },
      { label: "RUN 提及率", align: "right", render: (row) => escapeHtml(pct(row.mentioned_runs, row.valid_runs)) },
      { label: "目标文章", align: "right", render: (row) => `${num(row.tracked_cited)} / ${num(row.tracked_total)}` },
      { label: "创建时间", className: "nowrap", render: (row) => dateTime(row.created_at) },
    ],
    rows: batches,
    empty: "还没有批次，用上面的表单抽取一次。",
  }),
})}`,
  });
}

/* ------------------------------------------------------------------ 项目下的运行与来源 */

export function projectRunsPage({ project, runs }) {
  return layout({
    title: `${project.name} · 运行记录`,
    active: "projects",
    dbState: "数据库已连接",
    body: `${projectHeader(project, "runs", null)}
${panel(`运行记录（${num(runs.length)}）`, {
  hint: "只有「已确认新会话」的成功/部分成功运行才计入品牌提及率",
  body: dataTable({
    columns: [
      { label: "运行", render: (row) => runLink(row.local_run_id, truncate(row.local_run_id, 26)) },
      { label: "批次", render: (row) => (row.sampling_batch_id ? `<a href="/batches/${row.sampling_batch_id}">#${row.sampling_batch_id}</a>` : "—") },
      { label: "分类", render: (row) => escapeHtml(row.category ?? "—") },
      { label: "状态", render: (row) => badge(statusLabel(row.status), statusTone(row.status)) },
      { label: "新会话", render: (row) => resetBadge(row.conversation_reset_confirmed) },
      { label: "品牌", render: (row) => brandBadge(row.brand_mentioned) },
      { label: "引用", align: "right", render: (row) => citationCell(row) },
      { label: "提问", render: (row) => escapeHtml(truncate(row.prompt, 44)) },
      { label: "时间", className: "nowrap", render: (row) => dateTime(row.started_at) },
    ],
    rows: runs,
    empty: "该项目还没有运行记录。",
  }),
})}`,
  });
}

export function projectSourcesPage({ project, sources }) {
  return layout({
    title: `${project.name} · 引用来源`,
    active: "projects",
    dbState: "数据库已连接",
    body: `${projectHeader(project, "sources", null)}
${metricGrid([
  metric({ label: "可见引用", value: num(sources.totals.citations) }),
  metric({ label: "唯一文章", value: num(sources.totals.articles) }),
  metric({ label: "唯一域名", value: num(sources.totals.domains) }),
])}
${panel("域名分布", {
  body: dataTable({
    columns: [
      { label: "域名", render: (row) => escapeHtml(row.domain) },
      { label: "引用", align: "right", render: (row) => num(row.citations) },
      { label: "文章", align: "right", render: (row) => num(row.articles) },
      {
        label: "占比",
        align: "right",
        render: (row) =>
          `${escapeHtml(pct(row.citations, sources.totals.citations))} ${bar(row.citations, sources.totals.citations)}`,
      },
    ],
    rows: sources.domains,
    empty: "该项目还没有引用数据。",
  }),
})}
${panel("被引用最多的文章", {
  body: dataTable({
    columns: [
      {
        label: "文章",
        render: (row) =>
          `<a href="${escapeHtml(row.canonical_url)}" target="_blank" rel="noreferrer">${escapeHtml(truncate(row.title || row.canonical_url, 58))}</a>${row.is_tracked ? ` ${badge("监控中", "info")}` : ""}`,
      },
      { label: "域名", render: (row) => escapeHtml(row.normalized_domain ?? row.domain) },
      { label: "引用", align: "right", render: (row) => num(row.citations) },
      { label: "提问数", align: "right", render: (row) => num(row.prompts) },
    ],
    rows: sources.articles,
    empty: "该项目还没有引用数据。",
  }),
})}`,
  });
}

/* ------------------------------------------------------------------ 账号状态 */

const ACCOUNT_STATUS_LABELS = {
  unknown: "未知",
  healthy: "正常",
  cooldown: "冷却中",
  paused: "已暂停",
  disabled: "已禁用",
  login_required: "需要登录",
  session_expired: "登录态失效",
  verification_required: "需要人工验证",
  access_restricted: "访问受限",
  rate_limited: "触发频率限制",
};

const ACCOUNT_STATUS_TONES = {
  healthy: "ok",
  cooldown: "warn",
  rate_limited: "warn",
  paused: "warn",
  disabled: "muted",
  unknown: "muted",
  login_required: "bad",
  session_expired: "bad",
  verification_required: "bad",
  access_restricted: "bad",
};

function accountStatusBadge(status) {
  return badge(ACCOUNT_STATUS_LABELS[status] ?? status ?? "未知", ACCOUNT_STATUS_TONES[status] ?? "muted");
}

export function accountsPage({ accounts, notice: noticeMessage }) {
  const blocked = accounts.filter((account) =>
    ["login_required", "session_expired", "verification_required", "access_restricted", "cooldown", "paused"].includes(
      account.status,
    ),
  );

  const rows = accounts.map((account) => ({
    ...account,
    run_count: Number(account.run_count),
    run_count_today: Number(account.run_count_today),
  }));

  return layout({
    title: "账号状态",
    active: "accounts",
    dbState: "数据库已连接",
    body: `<h1>账号状态</h1>
<p class="lead">每个账号使用独立的浏览器 Profile。这里只展示派生状态与计数，不显示 Cookie 或完整登录态——
登录凭据始终只保存在服务器本地的 .onegl/auth/accounts/ 目录里。</p>
${noticeMessage ? notice(escapeHtml(noticeMessage)) : ""}
${
  blocked.length
    ? notice(
        `有 ${blocked.length} 个账号需要处理：${blocked
          .map((account) => `${account.account_key}（${ACCOUNT_STATUS_LABELS[account.status] ?? account.status}）`)
          .join("、")}。涉及登录或人工验证的账号，自动任务已停止，请人工处理后点「恢复」。`,
        "warn",
      )
    : ""
}
${metricGrid([
  metric({ label: "账号总数", value: num(accounts.length) }),
  metric({
    label: "可用账号",
    value: num(accounts.filter((account) => account.status === "healthy" && account.enabled).length),
    hint: "状态正常且已启用",
  }),
  metric({
    label: "需要人工处理",
    value: num(
      accounts.filter((account) =>
        ["login_required", "session_expired", "verification_required", "access_restricted"].includes(account.status),
      ).length,
    ),
    tone: accounts.some((account) =>
      ["login_required", "session_expired", "verification_required", "access_restricted"].includes(account.status),
    )
      ? "bad"
      : "ok",
  }),
  metric({
    label: "今日运行合计",
    value: num(rows.reduce((sum, row) => sum + row.run_count_today, 0)),
  }),
])}
${panel(`账号（${accounts.length}）`, {
  hint: "单账号同时只允许一个豆包会话任务",
  body: dataTable({
    columns: [
      { label: "账号", render: (row) => `<code>${escapeHtml(row.account_key)}</code>` },
      { label: "状态", render: (row) => accountStatusBadge(row.status) },
      { label: "启用", render: (row) => (row.enabled ? badge("已启用", "ok") : badge("已禁用", "muted")) },
      { label: "今日运行", align: "right", render: (row) => num(row.run_count_today) },
      { label: "累计运行", align: "right", render: (row) => num(row.run_count) },
      { label: "连续失败", align: "right", render: (row) => (row.consecutive_failures ? num(row.consecutive_failures) : "0") },
      { label: "最近运行", className: "nowrap", render: (row) => dateTime(row.last_run_at) },
      { label: "冷却至", className: "nowrap", render: (row) => dateTime(row.cooldown_until) },
      {
        label: "原因",
        render: (row) =>
          row.pause_reason
            ? escapeHtml(row.pause_reason)
            : row.last_error_code
              ? escapeHtml(errorCodeLabel(row.last_error_code))
              : "—",
      },
      {
        label: "登录态",
        render: (row) => (row.storage_state_present ? badge("已保存", "ok") : badge("未保存", "warn")),
      },
      {
        label: "操作",
        render: (row) => `<div class="actions">
          <form class="inline-form" method="post" action="/accounts/${encodeURIComponent(row.account_key)}/resume">
            <button class="ghost" type="submit">恢复</button></form>
          <form class="inline-form" method="post" action="/accounts/${encodeURIComponent(row.account_key)}/toggle">
            <input type="hidden" name="enabled" value="${row.enabled ? "false" : "true"}" />
            <button class="ghost" type="submit">${row.enabled ? "禁用" : "启用"}</button></form>
        </div>`,
      },
    ],
    rows,
    empty: "还没有账号。执行一次抽样或批量运行会自动登记账号。",
  }),
})}
${panel("需要人工处理时怎么做", {
  body: `<div class="panel-body padded">
    <div>遇到下面几种情况，系统会立即停止该账号的自动任务，不会重试，也不会尝试绕过平台校验：</div>
    <div class="hint">需要登录 / 登录态失效 / 需要人工验证 / 访问受限 —— 状态会标红，请在浏览器里人工处理后点「恢复」。</div>
    <div class="hint">触发频率限制 —— 会自动进入冷却，冷却结束后可继续使用。</div>
    ${cmd("npm run auth -- --account account_01", "重新登录某个账号（会打开浏览器窗口，登录态保存在本地）")}
    ${cmd("npm run worker", "启动后台采集 Worker（独立进程）")}
  </div>`,
})}`,
  });
}

export function notFoundPage(pathname) {
  return layout({
    title: "页面不存在",
    body: `<h1>404</h1><p class="lead">找不到 ${escapeHtml(pathname)}。</p><p><a href="/">返回总览</a></p>`,
  });
}

export function errorPage(message) {
  return layout({
    title: "服务异常",
    body: `<h1>服务异常</h1>${notice(escapeHtml(message), "bad")}`,
  });
}
