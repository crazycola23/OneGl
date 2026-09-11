import {
  badge,
  bar,
  cmd,
  dataTable,
  connectionText,
  emptyState,
  filters,
  formButton,
  kvList,
  layout,
  metric,
  metricGrid,
  notice,
  pageHead,
  panel,
  runLink,
  stackedBar,
  workerText,
} from "./layout.js";
import {
  ACCOUNT_GROUP_LABELS,
  ACCOUNT_STATUS_LABELS,
  ACCOUNT_STATUS_TONES,
  accountGroupOf,
} from "../system/status.js";
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

/* ------------------------------------------------------------ 通用小组件 */

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

function progressSegments(counts) {
  return [
    { label: "成功 / 部分成功", value: Number(counts.completed ?? 0), tone: "ok" },
    { label: "失败", value: Number(counts.failed ?? 0), tone: "bad" },
    { label: "跳过", value: Number(counts.skipped ?? 0), tone: "muted" },
    { label: "运行中", value: Number(counts.active ?? 0), tone: "info" },
  ];
}

function progressBlock(counts, { hint = "" } = {}) {
  const requested = Number(counts.requested ?? 0);
  const done = Number(counts.done ?? 0);
  const percent = requested ? Math.round((done / requested) * 100) : 0;
  return `<div>
    <div class="progress-head">
      <div><span class="count">${num(done)}</span> <span class="pct">/ ${num(requested)}</span></div>
      <div class="pct">${percent}%${hint ? ` · ${escapeHtml(hint)}` : ""}</div>
    </div>
    ${stackedBar(progressSegments(counts), requested)}
    <div class="legend">
      <span><i class="ok"></i>成功 / 部分成功 <b>${num(counts.completed)}</b></span>
      <span><i class="bad"></i>失败 <b>${num(counts.failed)}</b></span>
      <span><i class="muted"></i>跳过 <b>${num(counts.skipped)}</b></span>
      <span><i class="info"></i>运行中 <b>${num(counts.active)}</b></span>
      <span><i class="muted"></i>排队 <b>${num(counts.waiting)}</b></span>
    </div>
  </div>`;
}

/** 待处理事项 / 就绪阻塞项的统一样式。 */
function blockerList(items) {
  if (!items.length) {
    return `<div class="blocker">
  ${badge("正常", "ok")}
  <div class="body"><div>当前没有需要人工处理的问题。</div></div>
</div>`;
  }
  return items
    .map(
      (item) => `<div class="blocker">
  ${badge(item.tag, item.tone)}
  <div class="body">
    <div>${item.label}</div>
    ${item.detail ? `<div class="fix">${escapeHtml(item.detail)}</div>` : ""}
    ${item.fix ? `<div class="fix">→ ${escapeHtml(item.fix)}</div>` : ""}
  </div>
</div>`,
    )
    .join("");
}

/* ------------------------------------------------------------------ 总览 */

/**
 * 控制台首页。顺序刻意是「能不能跑 → 要我做什么 → 正在跑什么 → 跑得怎么样」，
 * 分析类指标放最后，因为操作状态优先于分析结果。
 */
export function homePage({
  db,
  system = null,
  overview,
  batches,
  activeBatches = [],
  attention = [],
  recentFailures = [],
  localRuns = [],
  localRunCount = 0,
}) {
  const blocks = [];

  if (!db?.ready) {
    blocks.push(
      notice(
        `未连接 PostgreSQL（${escapeHtml(db?.message ?? "未知原因")}），当前仅展示本地产物。` +
          `配置 <code>DATABASE_URL</code> 后执行 <code>npm run db:tunnel</code> 与 <code>npm run db:migrate</code>。`,
        "warn",
      ),
    );
  }

  /* 第一层：系统是否可运行 */
  const readiness = system?.readiness ?? { ready: false, blockers: [], warnings: [] };
  blocks.push(
    panel(readiness.ready ? "系统可以开始运行" : "系统尚未就绪", {
      hint: readiness.ready
        ? "数据库、Redis、Worker 与账号均已就绪"
        : "下面列出的问题需要先解决，否则批次不会真正执行",
      tone: readiness.ready ? "" : "blocked",
      body: blockerList([
        ...readiness.blockers.map((item) => ({
          tag: "阻塞",
          tone: "bad",
          label: item.label,
          detail: item.detail,
          fix: item.fix,
        })),
        ...readiness.warnings.map((item) => ({
          tag: "提醒",
          tone: "warn",
          label: item.label,
          detail: item.detail,
          fix: item.fix,
        })),
      ]),
    }),
  );

  /* 第二层：当前需要我处理什么 */
  blocks.push(
    panel(`待处理（${attention.length}）`, {
      hint: "只列需要人介入的事情；冷却一类的自动恢复不在这里",
      body: blockerList(attention),
    }),
  );

  /* 第三层：正在执行 */
  if (activeBatches.length) {
    blocks.push(
      panel(`正在执行（${activeBatches.length}）`, {
        hint: "页面每 5 秒自动刷新",
        body: activeBatches
          .map((item) => {
            const counts = item.counts ?? {};
            return `<div style="padding:16px;border-bottom:1px solid var(--border-solid)">
  <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:14px">
    <a href="/batches/${item.batch.id}"><b>#${item.batch.id} ${escapeHtml(truncate(item.batch.name, 46))}</b></a>
    ${badge(statusLabel(item.batch.status), statusTone(item.batch.status))}
    <span class="hint" style="margin:0">项目 ${escapeHtml(item.batch.project_name ?? "—")}</span>
    <span class="hint" style="margin:0">账号 ${escapeHtml((item.batch.account_keys ?? []).join("、") || "—")}</span>
    <span class="hint" style="margin-left:auto">最后心跳 ${dateTime(item.batch.last_heartbeat_at)}</span>
  </div>
  ${progressBlock(counts)}
</div>`;
          })
          .join(""),
      }) + `<script>setTimeout(function(){window.location.reload();}, 5000);</script>`,
    );
  } else {
    blocks.push(
      panel("正在执行", {
        body: emptyState("当前没有正在执行的批次。", {
          hint: "在「项目 → 抽样」中创建批次，然后在批次页点「开始监测」。",
          action: `<a class="linkbtn primary" href="/batches">去看批次</a>`,
        }),
      }),
    );
  }

  /* 第四层：最近批次的分析结果 */
  if (batches.length) {
    blocks.push(
      panel("最近批次", {
        hint: "批次是主要分析单位，点击进入完整报告",
        body: dataTable({
          columns: [
            { label: "批次", render: (row) => `<a href="/batches/${row.id}">#${row.id} ${escapeHtml(truncate(row.name, 30))}</a>` },
            { label: "项目", render: (row) => escapeHtml(row.project_name) },
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
            { label: "创建时间", className: "nowrap", render: (row) => dateTime(row.created_at) },
          ],
          rows: batches,
          empty: "还没有抽样批次。",
        }),
      }),
    );
  } else if (db?.ready) {
    blocks.push(
      panel("还没有批次", {
        body: emptyState("先建项目并录入关键词，才能抽样。", {
          action: `<a class="linkbtn primary" href="/projects">去建项目</a>`,
        }),
      }),
    );
  }

  if (recentFailures.length) {
    blocks.push(
      panel(`最近失败的运行（${recentFailures.length}）`, {
        hint: "失败原因直接决定下一步该看哪里",
        body: dataTable({
          columns: [
            { label: "运行", render: (row) => runLink(row.local_run_id, truncate(row.local_run_id, 24)) },
            { label: "状态", render: (row) => badge(statusLabel(row.status), statusTone(row.status)) },
            { label: "错误", render: (row) => badge(errorCodeLabel(row.error_code), "bad") },
            { label: "账号", render: (row) => `<code>${escapeHtml(row.account_key ?? "—")}</code>` },
            { label: "问题", render: (row) => escapeHtml(truncate(row.prompt, 44)) },
            { label: "时间", className: "nowrap", render: (row) => dateTime(row.started_at) },
          ],
          rows: recentFailures,
          rowTone: () => "bad",
        }),
      }),
    );
  }

  if (!db?.ready && localRuns.length) {
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

  blocks.push(
    panel("数据量", {
      hint: "只作为参考，不代表当前能不能跑",
      body: metricGrid([
        metric({ label: "项目", value: num(overview.projects) }),
        metric({ label: "关键词池 Prompt", value: num(overview.prompts) }),
        metric({ label: "抽样批次", value: num(overview.batches) }),
        metric({ label: "运行总数", value: num(overview.runs) }),
        metric({ label: "唯一文章", value: num(overview.articles) }),
        metric({ label: "可见引用", value: num(overview.citations) }),
      ]),
    }),
  );

  return layout({
    title: "操作台",
    active: "home",
    system,
    body: `${pageHead({
      kicker: "ONEGL · 操作台",
      title: "总览",
      sub: "先看系统是否就绪，再看需要处理什么，最后才看分析结果。",
    })}${blocks.join("")}`,
  });
}

/* ------------------------------------------------------------------ 批次列表 */

export function batchesPage({ db, batches, projects, projectId, system = null }) {
  if (!db.ready) {
    return layout({
      title: "批次",
      active: "batches",
      system,
      body: `${pageHead({ kicker: "批次", title: "批次" })}${notice(`未连接 PostgreSQL（${escapeHtml(db.message ?? "")}），无法读取批次。`, "warn")}`,
    });
  }

  const body = [];

  if (projects.length > 1) {
    const items = [{ href: "/batches", label: "全部项目", active: projectId == null }].concat(
      projects.map((project) => ({
        href: `/batches?project=${project.id}`,
        label: project.name,
        active: Number(projectId) === Number(project.id),
      })),
    );
    body.push(filters(items));
  }

  body.push(
    panel(`批次（${batches.length}）`, {
      hint: "每个批次代表一次完整实验：从关键词池按 seed 抽取 Prompt，分配账号，逐条真实提问",
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
    title: "批次",
    active: "batches",
    system,
    body: `${pageHead({
      kicker: "批次",
      title: "批次",
      sub: "创建后的执行、暂停、进度与结果都在这里。",
    })}${body.join("")}`,
  });
}

/* ------------------------------------------------------------------ 批次详情 */

/**
 * 执行控制区：状态、真实进度、运行环境与操作按钮。
 *
 * 进度用进度条而不是表格数字；开始前必须确认「将要执行多少个 Prompt、用几个账号」；
 * Worker 离线或 Redis 不可用时按钮直接禁用，不假装能跑。
 */
function executionPanel({ batch, progress, queueReady, system }) {
  const counts = progress?.counts ?? {
    requested: Number(batch.requested_jobs ?? 0),
    completed: Number(batch.completed_jobs ?? 0),
    failed: Number(batch.failed_jobs ?? 0),
    skipped: Number(batch.skipped_jobs ?? 0),
    waiting: 0,
    active: 0,
    done:
      Number(batch.completed_jobs ?? 0) +
      Number(batch.failed_jobs ?? 0) +
      Number(batch.skipped_jobs ?? 0),
    percent: 0,
  };
  const isActive = ["queued", "running"].includes(batch.status);
  const finished = ["completed", "partial", "failed", "aborted"].includes(batch.status);

  const accounts = batch.account_keys ?? [];
  const repeats = Math.max(1, Number(batch.repeats ?? 1));
  const sampleSize = Number(batch.sample_size ?? 0);
  // 真实任务量 = 抽中的 Prompt 数 × 每个 Prompt 的重复次数（不同账号轮转分配）。
  const plannedTasks = Number(batch.requested_jobs ?? 0) || sampleSize * repeats;

  const workerState = system?.worker?.state ?? "unknown";
  const workerOnline = workerState === "online";
  const redisReady = queueReady && system?.redis?.state === "connected";

  const blockReason = !queueReady
    ? "未配置 REDIS_URL，后台队列不可用"
    : !redisReady
      ? "Redis 连接失败，无法入队"
      : !workerOnline
        ? "Worker 未在线，请先启动 npm run worker"
        : "";

  const controls = [];
  if (isActive) {
    controls.push(
      formButton({
        action: `/batches/${batch.id}/stop`,
        label: "停止监测",
        tone: "danger",
        confirm: "确认停止监测？已完成的运行会保留，排队中的任务会被取消。",
      }),
    );
  } else {
    const confirmText = [
      finished ? "确认重新开始监测？" : "确认开始监测？",
      "",
      `将向豆包执行 ${plannedTasks} 个任务：抽样 ${sampleSize} 条 × 重复 ${repeats} 次。`,
      `使用 ${accounts.length} 个账号：${accounts.join("、") || "未配置"}。`,
      "",
      "任务由 Worker 在后台串行执行，可在本页随时停止。",
    ].join("\\n");

    controls.push(
      formButton({
        action: `/batches/${batch.id}/start`,
        label: finished ? "重新执行" : "开始监测",
        tone: "primary",
        confirm: blockReason ? null : confirmText,
        disabled: Boolean(blockReason),
        reason: blockReason,
      }),
    );
  }

  const runtime = kvList([
    ["Worker", `${workerText(workerState)}${workerOnline ? "（心跳正常）" : ""}`],
    ["Redis", connectionText(system?.redis?.state)],
    ["数据库", connectionText(system?.database?.state)],
    ["最后心跳", dateTime(system?.worker?.heartbeat?.at)],
    ["Worker 进程", system?.worker?.heartbeat ? `pid ${system.worker.heartbeat.pid}` : "—"],
    ["账号", accounts.length ? accounts.join("、") : "—"],
    ["入队时间", dateTime(batch.queued_at)],
    ["开始时间", dateTime(batch.started_at)],
    ["结束时间", dateTime(batch.finished_at)],
    ["批次心跳", dateTime(batch.last_heartbeat_at)],
  ]);

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
        set("p-done", c.done); set("p-requested", c.requested);
        set("p-completed", c.completed); set("p-failed", c.failed);
        set("p-skipped", c.skipped); set("p-active", c.active);
        set("p-waiting", c.waiting); set("p-percent", c.percent + "%");
        ["ok", "bad", "muted", "info"].forEach(function (tone) {
          const el = document.getElementById("p-seg-" + tone);
          if (el) {
            const key = { ok: "completed", bad: "failed", muted: "skipped", info: "active" }[tone];
            const total = c.requested || 1;
            el.style.width = ((c[key] || 0) / total) * 100 + "%";
          }
        });
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

  return panel("执行控制", {
    hint: isActive ? "执行中，页面每 4 秒刷新进度" : "由 Worker 独立进程执行，不占用 Web 进程",
    body: `<div style="padding:16px">
      ${
        blockReason
          ? notice(`${escapeHtml(blockReason)}`, "warn")
          : isActive
            ? ""
            : notice(
                `本次将执行 <strong>${plannedTasks}</strong> 个任务（抽样 ${sampleSize} 条 × 重复 ${repeats} 次），使用 ${accounts.length} 个账号。`,
              )
      }
      <div class="grid-2">
        <div>
          <div class="progress-head">
            <div><span class="count" id="p-done">${num(counts.done)}</span> <span class="pct">/ <span id="p-requested">${num(counts.requested)}</span></span></div>
            <div class="pct" id="p-percent">${escapeHtml(`${counts.percent}%`)}</div>
          </div>
          <div class="bar stacked">
            <i class="ok" id="p-seg-ok" style="width:${counts.requested ? (counts.completed / counts.requested) * 100 : 0}%"></i>
            <i class="bad" id="p-seg-bad" style="width:${counts.requested ? (counts.failed / counts.requested) * 100 : 0}%"></i>
            <i class="muted" id="p-seg-muted" style="width:${counts.requested ? (counts.skipped / counts.requested) * 100 : 0}%"></i>
            <i class="info" id="p-seg-info" style="width:${counts.requested ? (counts.active / counts.requested) * 100 : 0}%"></i>
          </div>
          <div class="legend">
            <span><i class="ok"></i>成功 / 部分成功 <b id="p-completed">${num(counts.completed)}</b></span>
            <span><i class="bad"></i>失败 <b id="p-failed">${num(counts.failed)}</b></span>
            <span><i class="muted"></i>跳过 <b id="p-skipped">${num(counts.skipped)}</b></span>
            <span><i class="info"></i>运行中 <b id="p-active">${num(counts.active)}</b></span>
            <span><i class="muted"></i>排队 <b id="p-waiting">${num(counts.waiting)}</b></span>
          </div>
          <div class="actions" style="margin-top:18px">${controls.join("")}
            <span class="hint" style="margin-left:8px">当前状态：<b id="p-status">${escapeHtml(statusLabel(batch.status))}</b></span>
          </div>
        </div>
        <div class="card" style="margin:0"><div class="card-head"><strong>运行环境</strong></div>${runtime}</div>
      </div>
    </div>`,
  }) + poller;
}

export function batchPage({
  report,
  runs,
  sources,
  progress,
  queueReady,
  system = null,
  errorFilter = null,
}) {
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
    executionPanel({ batch, progress, queueReady, system }),
    header,
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
    panel("命令行与复现（高级 / 故障排查）", {
      hint: "网页端已可完成创建、执行与停止；这些命令用于调试与复现",
      body: `<div class="card-body pad">
        ${cmd(`npm run batch:run -- --batch ${batch.id}`, "在前台执行该批次（不依赖 Redis 与 Worker）")}
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
    system,
    body: `${pageHead({
      kicker: `<a href="/batches">批次</a>`,
      title: `批次 #${batch.id} ${badge(statusLabel(batch.status), statusTone(batch.status))}`,
      sub: `${escapeHtml(batch.project_name)} · ${escapeHtml(batch.name)} · 目标品牌 ${escapeHtml(batch.target_brand ?? "未配置")}`,
    })}${blocks.join("")}`,
  });
}

/* ------------------------------------------------------------------ 运行列表 */

/** 运行列表。调试入口：失败要高亮，筛选要能直接定位到人、批次与错误码。 */
export function runsPage({
  db,
  system = null,
  runs = [],
  projects = [],
  accounts = [],
  batches = [],
  errorCodes = [],
  filters: filterState = {},
  localRuns = [],
}) {
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
      system,
      body: `${pageHead({ kicker: "运行记录", title: "运行记录" })}${body.join("")}`,
    });
  }

  const statusFilters = [
    { href: urlForRuns(filterState, { status: null }), label: "全部", active: !filterState.status },
    { href: urlForRuns(filterState, { status: "success" }), label: "成功", active: filterState.status === "success" },
    { href: urlForRuns(filterState, { status: "partial" }), label: "部分成功", active: filterState.status === "partial" },
    { href: urlForRuns(filterState, { status: "failed" }), label: "失败", active: filterState.status === "failed" },
  ];

  body.push(filters(statusFilters));

  const selected = (value, current) => (String(value ?? "") === String(current ?? "") ? " selected" : "");
  body.push(
    panel("筛选", {
      hint: "按项目、批次、账号或错误码定位到具体一次运行",
      body: `<div class="card-body pad">
        <form method="get" action="/runs" class="form-row">
          <div class="field grow"><label>项目</label>
            <select name="project">
              <option value="">全部项目</option>
              ${projects
                .map(
                  (project) =>
                    `<option value="${project.id}"${selected(project.id, filterState.projectId)}>${escapeHtml(project.name)}</option>`,
                )
                .join("")}
            </select></div>
          <div class="field grow"><label>批次</label>
            <select name="batch">
              <option value="">全部批次</option>
              ${batches
                .map(
                  (batch) =>
                    `<option value="${batch.id}"${selected(batch.id, filterState.batchId)}>#${batch.id} ${escapeHtml(truncate(batch.name, 28))}</option>`,
                )
                .join("")}
            </select></div>
          <div class="field"><label>状态</label>
            <select name="status">
              <option value=""${selected("", filterState.status)}>全部</option>
              ${["success", "partial", "failed"]
                .map(
                  (status) =>
                    `<option value="${status}"${selected(status, filterState.status)}>${escapeHtml(statusLabel(status))}</option>`,
                )
                .join("")}
            </select></div>
          <div class="field"><label>账号</label>
            <select name="account">
              <option value="">全部账号</option>
              ${accounts
                .map(
                  (key) => `<option value="${escapeHtml(key)}"${selected(key, filterState.account)}>${escapeHtml(key)}</option>`,
                )
                .join("")}
            </select></div>
          <div class="field grow"><label>错误码</label>
            <select name="error">
              <option value="">全部错误</option>
              ${errorCodes
                .map(
                  (item) =>
                    `<option value="${escapeHtml(item.code)}"${selected(item.code, filterState.errorCode)}>${escapeHtml(item.code)}（${item.runs}）</option>`,
                )
                .join("")}
            </select></div>
          <button type="submit">筛选</button>
          <a class="linkbtn" href="/runs">清除</a>
        </form>
      </div>`,
    }),
  );

  body.push(
    panel(`运行记录（${num(runs.length)}）`, {
      hint: "失败行会高亮；点运行 ID 进入调试详情",
      body: dataTable({
        columns: [
          { label: "运行", render: (row) => runLink(row.local_run_id, truncate(row.local_run_id, 24)) },
          { label: "状态", render: (row) => badge(statusLabel(row.status), statusTone(row.status)) },
          { label: "Attempt", align: "right", render: (row) => num(row.attempt ?? 1) },
          { label: "项目 / 批次", render: (row) =>
              `${escapeHtml(row.project_name)}${
                row.sampling_batch_id
                  ? ` <a href="/batches/${row.sampling_batch_id}">#${row.sampling_batch_id}</a>`
                  : ""
              }` },
          { label: "账号", render: (row) => `<code>${escapeHtml(row.account_key ?? "—")}</code>` },
          { label: "新会话", render: (row) => resetBadge(row.conversation_reset_confirmed) },
          { label: "引用", align: "right", render: (row) => citationCell(row) },
          { label: "回答", align: "right", render: (row) =>
              row.answer_chars == null ? "—" : `${num(row.answer_chars)} 字` },
          { label: "错误", render: (row) => (row.error_code ? badge(error_code_short(row.error_code), "bad") : "—") },
          { label: "问题", render: (row) => escapeHtml(truncate(row.prompt, 38)) },
          { label: "时间", className: "nowrap", render: (row) => dateTime(row.started_at) },
        ],
        rows: runs,
        empty: "没有符合条件的运行记录。",
        rowTone: (row) => (row.status === "failed" ? "bad" : row.status === "partial" ? "warn" : ""),
      }),
    }),
  );

  return layout({
    title: "运行记录",
    active: "runs",
    system,
    body: `${pageHead({
      kicker: "运行记录",
      title: "运行记录",
      sub: "每一次向豆包发出的真实提问。只有「已确认新会话」的成功/部分成功运行才进入品牌提及率统计。",
    })}${body.join("")}`,
  });
}

/** 保留当前筛选条件、只改其中一项的链接。 */
function urlForRuns(filterState, patch) {
  const merged = {
    project: filterState.projectId,
    batch: filterState.batchId,
    status: filterState.status,
    account: filterState.account,
    error: filterState.errorCode,
    ...patch,
  };
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(merged)) {
    if (value != null && value !== "") params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `/runs?${query}` : "/runs";
}

/** 错误码很长，列表里只显示尾段，完整值在详情页。 */
function error_code_short(code) {
  return String(code).replace(/^DOUBAO_/, "");
}

/* ------------------------------------------------------------------ 运行详情 */

/** 磁盘上真实存在的 attempt 目录 → 时间线，附每次尝试的产物链接。 */
function renderAttemptTimeline(runId, attempts, { attempt, source, localRun }) {
  return `<div class="timeline">${attempts
    .map((entry) => {
      // 历史尝试的结论来自 run.json 的 attemptHistory；当前这次直接看运行状态。
      const record = (localRun?.attemptHistory ?? []).find(
        (item) => Number(item.attempt) === Number(entry.attempt),
      );
      const isCurrent = Number(entry.attempt) === attempt;
      const status = isCurrent ? source.status : (record?.status ?? "unknown");
      return `<div class="timeline-row">
  <div class="when">Attempt ${entry.attempt}${isCurrent ? "（当前）" : ""}</div>
  <div>${badge(statusLabel(status), statusTone(status))}${
    !isCurrent && record?.errorCode
      ? `<div class="hint" style="margin-top:4px">${escapeHtml(record.errorCode)}</div>`
      : ""
  }</div>
  <div>
    <div class="mono" style="font-size:12px;color:var(--text-3)">${escapeHtml(entry.dir)}</div>
    <div class="artifacts">${entry.files
      .map(
        (file) =>
          `<a class="linkbtn" href="/artifacts/${encodeURIComponent(runId)}/attempts/${entry.attempt}/${encodeURIComponent(file)}" target="_blank" rel="noreferrer">${escapeHtml(file)}</a>`,
      )
      .join("")}</div>
  </div>
</div>`;
    })
    .join("")}</div>`;
}

/** 旧布局（产物直接在运行目录下）的产物链接，保证历史 Run 也能调试。 */
function renderLegacyArtifacts(runId, files, { attempt, source }) {
  return `<div class="timeline"><div class="timeline-row">
  <div class="when">Attempt ${attempt}（当前）</div>
  <div>${badge(statusLabel(source.status), statusTone(source.status))}</div>
  <div>
    <div class="mono" style="font-size:12px;color:var(--text-3)">旧布局：产物位于运行目录根部</div>
    <div class="artifacts">${files
      .map(
        (file) =>
          `<a class="linkbtn" href="/artifacts/${encodeURIComponent(runId)}/${encodeURIComponent(file)}" target="_blank" rel="noreferrer">${escapeHtml(file)}</a>`,
      )
      .join("")}</div>
  </div>
</div></div>`;
}

/**
 * 运行详情：调试主页面。
 *
 * 阅读顺序是刻意的 —— 先结论（成败、第几次尝试、为什么失败），再证据（回答、引用），
 * 最后才是元数据。失败时不需要滚到底部才知道原因。
 */
export function runPage({
  db,
  system = null,
  run = null,
  citations = [],
  localRun = null,
  attempts = [],
  rootArtifacts = [],
  runId,
}) {
  if (!run && !localRun) {
    return layout({
      title: "运行不存在",
      active: "runs",
      system,
      body: `${pageHead({ kicker: "运行记录", title: "运行不存在", sub: `找不到 ${escapeHtml(runId)}。` })}<p><a class="linkbtn" href="/runs">返回运行记录</a></p>`,
    });
  }

  const source = run ?? localRun;
  const blocks = [];

  const captured = run ? Number(run.captured_citation_count ?? 0) : (localRun.citations || []).length;
  const expected = run ? run.expected_citation_count : localRun?.expectedCitationCount;
  const mismatch = expected != null && captured !== Number(expected);

  const startedAt = run?.started_at ?? localRun?.startedAt;
  const finishedAt = run?.finished_at ?? localRun?.completedAt;
  const durationMs =
    startedAt && finishedAt ? new Date(finishedAt).getTime() - new Date(startedAt).getTime() : null;

  const attempt = Number(run?.attempt ?? localRun?.attempt ?? 1);
  const attemptList = localRun?.attempts ?? [attempt];

  /* 结论优先：失败原因紧跟标题，不放在页面底部 */
  if (source.error_code) {
    const details = run?.error_details ?? localRun?.errorDetails ?? null;
    blocks.push(
      notice(
        `<strong>${escapeHtml(source.error_code)}</strong> — ${escapeHtml(errorCodeLabel(source.error_code))}<br>` +
          `${escapeHtml(run?.error_message ?? localRun?.errorMessage ?? "")}`,
        "bad",
      ),
    );
    if (details) {
      blocks.push(
        panel("失败详情 error_details", {
          hint: "采集阶段记录的结构化上下文",
          body: `<div class="card-body pad"><pre>${escapeHtml(JSON.stringify(details, null, 2))}</pre></div>`,
        }),
      );
    }
  }

  blocks.push(
    metricGrid([
      metric({
        label: "状态",
        value: statusLabel(source.status),
        tone: statusTone(source.status),
        hint: source.error_code ? errorCodeLabel(source.error_code) : "无错误",
      }),
      metric({
        label: "Attempt",
        value: `${num(attempt)} / ${num(Math.max(...attemptList.map(Number), attempt))}`,
        hint: attemptList.length > 1 ? `共尝试 ${attemptList.length} 次` : "首次尝试",
        tone: attempt > 1 ? "warn" : "",
      }),
      metric({
        label: "引用核对",
        value: expected == null ? num(captured) : `${num(captured)} / ${num(expected)}`,
        hint: expected == null ? "页面未标注引用数" : mismatch ? "抓取数与页面标注不一致" : "与页面标注一致",
        tone: expected == null ? "" : mismatch ? "warn" : "ok",
      }),
      metric({
        label: "新会话确认",
        value: source.conversation_reset_confirmed === true ? "已确认" : source.conversation_reset_confirmed === false ? "未确认" : "未知",
        hint: "只有确认从空会话开始的运行才计入统计",
        tone: source.conversation_reset_confirmed === true ? "ok" : "warn",
      }),
      metric({
        label: "耗时",
        value: durationMs == null ? "—" : `${(durationMs / 1000).toFixed(1)} 秒`,
        hint: dateTime(finishedAt),
      }),
      metric({
        label: "品牌提及",
        value: run ? (run.brand_mentioned === true ? "已提及" : run.brand_mentioned === false ? "未提及" : "未检测") : "—",
        hint: run?.mention_count != null ? `出现 ${num(run.mention_count)} 次` : "该项目未配置目标品牌",
        tone: run?.brand_mentioned === true ? "ok" : "",
      }),
    ]),
  );

  /* 引用核对单独一块：不一致必须显著 */
  blocks.push(
    panel("引用核对", {
      hint: "Expected 来自豆包界面标注，Captured 是实际解析到的条数",
      tone: mismatch ? "blocked" : "",
      body: `<div class="card-body pad">
        <div class="total-preview">
          <div><div class="hint">Expected（页面标注）</div><b>${expected == null ? "—" : num(expected)}</b></div>
          <div><div class="hint">Captured（实际抓取）</div><b class="${mismatch ? "risky" : "safe"}">${num(captured)}</b></div>
          <div><div class="hint">结论</div><b class="${mismatch ? "risky" : "safe"}">${
            expected == null ? "页面未标注" : mismatch ? "不一致" : "一致"
          }</b></div>
          <div><div class="hint">引用状态 citation_state</div><b>${escapeHtml(source.citation_state ?? "—")}</b></div>
        </div>
        ${
          mismatch
            ? `<div class="hint">差额原因尚未确认：可能来自折叠展示、DOM 结构变化或解析未覆盖。引用来源统计按保守口径展示。</div>`
            : ""
        }
      </div>`,
    }),
  );

  /* Attempt 时间线：重试过就必须看得出第几次失败、失败在哪一步 */
  const timelineBody = attempts.length
    ? renderAttemptTimeline(runId, attempts, { attempt, source, localRun })
    : rootArtifacts.length
      ? renderLegacyArtifacts(runId, rootArtifacts, { attempt, source })
      : emptyState("本次运行还没有落地产物目录。", {
          hint: ".onegl/runs/<run_id>/attempts/<n>/ 下应当存在截图、HTML 快照与回答。",
        });

  blocks.push(
    panel(`Attempt 历史（${attemptList.length}）`, {
      hint: attempts.length
        ? "每次尝试的现场各自保留在独立目录，不会互相覆盖"
        : rootArtifacts.length
          ? "这条运行使用旧产物布局：产物直接放在运行目录下，没有 attempts/ 子目录"
          : "本地产物缺失时只能显示数据库中的最终 attempt",
      body: timelineBody,
    }),
  );

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
    panel("提问与回答", {
      body: `<div class="card-body pad">
        <h3>提问 Prompt</h3>
        <pre>${escapeHtml(source.prompt ?? run?.prompt ?? "")}</pre>
        <h3>回答 Answer</h3>
        <pre>${escapeHtml(run?.answer ?? localRun?.answer ?? "（未抓到回答）")}</pre>
      </div>`,
    }),
  );

  const citationRows = citations ?? [];
  blocks.push(
    panel(`可见引用（${num(citationRows.length)}）`, {
      hint: "只包含 source_type = visible、在豆包界面对用户可见的来源；retrieved 不会混入",
      body: dataTable({
        columns: [
          { label: "#", align: "right", render: (row) => num(row.source_position) },
          {
            label: "文章",
            render: (row) =>
              row.original_url
                ? `<a href="${escapeHtml(row.original_url)}" target="_blank" rel="noreferrer">${escapeHtml(truncate(row.title || row.original_url, 52))}</a>${row.tracked_article_id ? ` ${badge("监控中", "info")}` : ""}`
                : escapeHtml(row.title ?? "—"),
          },
          { label: "域名", render: (row) => escapeHtml(row.normalized_domain ?? row.domain ?? "—") },
          {
            label: "来源",
            render: (row) =>
              `${badge(row.source_type ?? "visible", (row.source_type ?? "visible") === "visible" ? "ok" : "warn")} ${escapeHtml(row.captured_from ?? "DOM")}`,
          },
          {
            label: "关联状态",
            render: (row) =>
              badge(
                row.relation_status === "matched" ? "已匹配正文" : "未匹配",
                row.relation_status === "matched" ? "ok" : "muted",
              ),
          },
          { label: "可见", render: (row) => (row.visible_to_user === false ? badge("否", "warn") : badge("是", "muted")) },
          {
            label: "Canonical URL",
            render: (row) =>
              `<span class="mono" style="font-size:11.5px">${escapeHtml(truncate(row.canonical_url ?? "—", 60))}</span>`,
          },
        ],
        rows: citationRows,
        empty: "该次运行没有可见引用。",
      }),
    }),
  );

  const meta = [];
  if (run) {
    meta.push(["项目", escapeHtml(run.project_name)]);
    meta.push(["批次", run.sampling_batch_id ? `<a href="/batches/${run.sampling_batch_id}">#${run.sampling_batch_id}</a>` : "—"]);
    meta.push(["账号", `<code>${escapeHtml(run.account_key ?? "—")}</code>`]);
    meta.push(["服务方", escapeHtml(run.provider)]);
    meta.push(["提交方式", run.submission_method === "send_button" ? "发送按钮" : run.submission_method === "enter_key" ? "回车键" : "—"]);
    meta.push(["开始 / 结束", `${dateTime(run.started_at)} → ${dateTime(run.finished_at)}`]);
    meta.push(["本地运行 ID", `<code>${escapeHtml(run.local_run_id)}</code>`]);
  } else {
    meta.push(["项目", escapeHtml(localRun.project ?? "—")]);
    meta.push(["账号", `<code>${escapeHtml(localRun.accountKey ?? "—")}</code>`]);
    meta.push(["开始 / 结束", `${dateTime(localRun.startedAt)} → ${dateTime(localRun.completedAt)}`]);
  }
  meta.push(["产物目录", `<code>${escapeHtml(localRun?.artifactPath ?? run?.artifact_path ?? "—")}</code>`]);
  meta.push(["运行目录", `<code>${escapeHtml(localRun?.debugPath ?? "—")}</code>`]);

  blocks.push(panel("运行信息", { body: kvList(meta) }));

  if (attempts.length > 0) {
    const current = attempts.find((entry) => Number(entry.attempt) === attempt) ?? attempts.at(-1);
    const shot = current?.files.includes("screenshot.png");
    if (shot) {
      blocks.push(
        panel(`当前 Attempt 截图（attempt ${current.attempt}）`, {
          hint: "数据库只保存结构化数据，截图与 HTML 快照保留在本地",
          body: `<div class="card-body pad">
            <img class="shot" src="/artifacts/${encodeURIComponent(runId)}/attempts/${current.attempt}/screenshot.png" alt="运行截图" />
          </div>`,
        }),
      );
    }
  } else if (localRun) {
    blocks.push(
      panel("本地调试产物", {
        hint: "数据库只保存结构化数据，截图与 HTML 快照保留在本地",
        body: `<div class="card-body pad">
          <img class="shot" src="/artifacts/${encodeURIComponent(runId)}/screenshot.png" alt="运行截图" />
        </div>`,
      }),
    );
  }

  return layout({
    title: truncate(runId, 30),
    active: "runs",
    system,
    body: `${pageHead({
      kicker: `<a href="/runs">运行记录</a>`,
      title: `${escapeHtml(runId)} ${badge(statusLabel(source.status), statusTone(source.status))}`,
      sub: run
        ? `${escapeHtml(run.project_name)}${run.sampling_batch_id ? ` · 批次 <a href="/batches/${run.sampling_batch_id}">#${run.sampling_batch_id}</a>` : ""} · 账号 <code>${escapeHtml(run.account_key ?? "—")}</code>`
        : "本地产物（未写入数据库）",
    })}${blocks.join("")}`,
  });
}

/* ------------------------------------------------------------------ 引用来源 */

export function sourcesPage({ db, sources, projects, projectId, system = null }) {
  if (!db.ready) {
    return layout({
      title: "引用来源",
      active: "sources",
      system,
      body: `${pageHead({ kicker: "引用来源", title: "引用来源" })}${notice(`未连接 PostgreSQL（${escapeHtml(db.message ?? "")}），无法聚合引用来源。`, "warn")}`,
    });
  }

  const body = [
    notice(
      `口径说明：只统计 <code>source_type = visible</code> 的引用——豆包最终用户可见的引用 UI，不包含搜索请求、训练数据或后台检索结果。` +
        `将来如果接入了其它通道抓到的来源，它们会以 <code>retrieved</code> 单独存放，<strong>不会默认混入本页统计</strong>。` +
        `另外，当页面标注的引用数高于成功解析数时，差额成因尚未确认（可能是折叠展示、DOM 变化或解析未覆盖），因此本页按保守口径展示。`,
    ),
    metricGrid([
      metric({ label: "可见引用", value: num(sources.totals.citations) }),
      metric({ label: "唯一文章", value: num(sources.totals.articles) }),
      metric({ label: "唯一域名", value: num(sources.totals.domains) }),
    ]),
  ];

  if (projects.length > 1) {
    const items = [{ href: "/sources", label: "全部项目", active: projectId == null }].concat(
      projects.map((project) => ({
        href: `/sources?project=${project.id}`,
        label: project.name,
        active: Number(projectId) === Number(project.id),
      })),
    );
    body.push(filters(items));
  }

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
    system,
    body: `${pageHead({
      kicker: "引用来源",
      title: "引用来源",
      sub: "以下来源全部来自豆包最终用户可见的引用 UI。",
    })}${body.join("")}`,
  });
}

/* ------------------------------------------------------------------ 项目列表 */

export function projectsPage({ db, projects, notice: noticeMessage = null, system = null }) {
  if (!db.ready) {
    return layout({
      title: "项目",
      active: "projects",
      system,
      body: `${pageHead({ kicker: "项目", title: "项目" })}${notice(`未连接 PostgreSQL（${escapeHtml(db.message ?? "")}）。`, "warn")}`,
    });
  }

  return layout({
    title: "项目",
    active: "projects",
    system,
    body: `${pageHead({
      kicker: "项目",
      title: "项目",
      sub: "每个项目拥有完全独立的关键词池，抽样只会从当前项目自己启用的关键词中抽取，项目之间互不影响。",
    })}
${noticeMessage ? notice(escapeHtml(noticeMessage.message ?? noticeMessage)) : ""}
${panel("新建项目", {
  hint: "创建后在「关键词池」页面人工录入关键词",
  body: `<div class="card-body pad">
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
${pageHead({
  kicker: `<a href="/projects">项目</a>`,
  title: escapeHtml(project.name),
  sub: escapeHtml(project.description ?? "（无描述）"),
})}
${noticeMessage ? notice(escapeHtml(noticeMessage)) : ""}`;
}

/* ------------------------------------------------------------------ 项目概览 */

export function projectOverviewPage({ project, pool, tracked, accounts, batches, keywordStats, system = null, dailyLimit = 60 }) {
  const aliases =
    (project.brand_aliases ?? []).map((term) => `<span class="term">${escapeHtml(term)}</span>`).join(" ") || "—";
  const products =
    (project.brand_product_aliases ?? []).map((term) => `<span class="term">${escapeHtml(term)}</span>`).join(" ") || "—";
  const excludes =
    (project.brand_exclude_patterns ?? []).map((term) => `<code>${escapeHtml(term)}</code>`).join(" ") || "—";

  return layout({
    title: project.name,
    active: "projects",
    system,
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
    return formButton({ action: `${base}/restore`, label: "恢复", tone: "secondary" });
  }
  const nextEnabled = keyword.enabled ? "false" : "true";
  return `<div class="actions">
    ${formButton({
      action: `${base}/toggle`,
      label: keyword.enabled ? "禁用" : "启用",
      tone: "secondary",
      field: `<input type="hidden" name="enabled" value="${nextEnabled}" />`,
    })}
    ${formButton({
      action: `${base}/delete`,
      label: "删除",
      tone: "danger",
      confirm: "确认删除这个关键词？历史运行记录与批次会保留。",
    })}
  </div>`;
}

export function projectKeywordsPage({ project, keywords, stats, notice: noticeMessage, system = null }) {
  const alive = keywords.filter((keyword) => !keyword.deleted_at);

  return layout({
    title: `${project.name} · 关键词池`,
    active: "projects",
    system,
    body: `${projectHeader(project, "keywords", noticeMessage)}
${metricGrid([
  metric({ label: "启用中", value: num(stats.enabled), hint: "只有启用中的关键词会被抽样" }),
  metric({ label: "未删除", value: num(stats.total) }),
  metric({ label: "已删除", value: num(stats.deleted), hint: "删除为软删除，历史记录不受影响" }),
])}
${panel("添加到关键词池", {
  hint: "人工录入，多个关键词用 # 分隔",
  body: `<div class="card-body pad">
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

/**
 * 抽样页。账号用选择而不是让操作者手打账号名——数据库已经知道有哪些账号了。
 * 创建之前必须把「最终会执行多少个任务」算给操作者看，避免一点就跑出去几百个 Prompt。
 */
export function projectSamplingPage({
  project,
  batches,
  accounts = [],
  stats,
  notice: noticeMessage,
  system = null,
  dailyLimit = 60,
}) {
  const groups = { healthy: [], auto_waiting: [], manual_attention: [], disabled: [] };
  for (const account of accounts) groups[accountGroupOf(account, { dailyLimit })].push(account);

  const defaultSize = Math.min(20, Math.max(1, Number(stats.enabled)));
  const selectable = [
    ...groups.healthy.map((account) => ({ account, blocked: false, group: "healthy" })),
    ...groups.auto_waiting.map((account) => ({ account, blocked: true, group: "auto_waiting" })),
    ...groups.manual_attention.map((account) => ({ account, blocked: true, group: "manual_attention" })),
    ...groups.disabled.map((account) => ({ account, blocked: true, group: "disabled" })),
  ];

  const accountPicker = selectable.length
    ? `<div class="account-pick" id="accountPick">${selectable
        .map(({ account, blocked, group }) => {
          const statusText = accountStatusText(account, dailyLimit);
          return `<label class="${blocked ? "blocked" : ""}">
  <input type="checkbox" name="accounts" value="${escapeHtml(account.account_key)}"
         data-usable="${blocked ? "false" : "true"}"
         ${blocked ? "disabled" : "checked"} />
  <code>${escapeHtml(account.account_key)}</code>
  ${badge(ACCOUNT_GROUP_LABELS[group], group === "healthy" ? "ok" : group === "auto_waiting" ? "warn" : group === "manual_attention" ? "bad" : "muted")}
  <span class="meta">${escapeHtml(statusText)}</span>
</label>`;
        })
        .join("")}</div>`
    : emptyState("尚未配置账号。", {
        hint: "先在「账号」页确认有可用账号，再回来抽样。",
      });

  const usableCount = groups.healthy.length;

  const form = `<form method="post" action="/projects/${project.id}/sampling" class="form-block" id="samplingForm">
  <div class="form-row">
    <div class="field narrow"><label>抽样数量（从启用关键词中抽）</label>
      <input type="number" id="sizeInput" name="size" min="1" max="${Math.max(1, Number(stats.enabled))}"
             value="${defaultSize}" required /></div>
    <div class="field"><label>抽样方式</label>
      <select name="method" id="methodInput">
        <option value="stratified">分层抽样（按分类按比例）</option>
        <option value="random">纯随机抽样</option>
      </select></div>
    <div class="field narrow"><label>每个问题重复次数</label>
      <input type="number" id="repeatsInput" name="repeats" min="1" value="1" /></div>
  </div>

  <div class="field"><label>使用哪些账号（只有「正常」的账号可选）</label>
    ${accountPicker}
  </div>

  <div class="total-preview">
    <div><div class="hint">可抽样关键词</div><b>${num(stats.enabled)}</b></div>
    <div><div class="hint">抽取 Prompt</div><b id="pv-size">${num(defaultSize)}</b></div>
    <div><div class="hint">Repeats</div><b id="pv-repeats">1</b></div>
    <div><div class="hint">选中账号</div><b id="pv-accounts">${num(usableCount)}</b></div>
    <div><div class="hint">最终任务数</div><b id="pv-total" class="safe">${num(defaultSize)}</b></div>
  </div>
  <div class="hint" id="pv-note">最终任务数 = 抽取 Prompt × Repeats（不同账号轮转分配）。</div>

  <details class="help"><summary>高级选项：抽样种子</summary>
    <div>
      留空则自动生成。填写同一种子可以完整复现本次抽样（问题、账号分配、顺序都一致）。
      <input type="text" name="seed" placeholder="例如 20260911-ab12" style="margin-top:8px" />
    </div>
  </details>

  <div class="actions">
    <button type="submit" ${usableCount ? "" : `disabled title="没有可用账号"`}>抽取并创建批次</button>
    <span class="hint" style="margin:0">创建后进入批次页，在那里点「开始监测」执行。</span>
  </div>
</form>

<script>
(function () {
  const size = document.getElementById("sizeInput");
  const repeats = document.getElementById("repeatsInput");
  const pick = document.getElementById("accountPick");
  const out = {
    size: document.getElementById("pv-size"),
    repeats: document.getElementById("pv-repeats"),
    accounts: document.getElementById("pv-accounts"),
    total: document.getElementById("pv-total"),
  };
  function refresh() {
    const s = Math.max(0, Number(size.value) || 0);
    const r = Math.max(1, Number(repeats.value) || 1);
    const picked = pick ? pick.querySelectorAll('input[type="checkbox"]:checked').length : 0;
    const total = s * r;
    out.size.textContent = s; out.repeats.textContent = r; out.accounts.textContent = picked;
    out.total.textContent = total;
    out.total.className = total > 100 ? "risky" : "safe";
  }
  [size, repeats].forEach(function (el) { el.addEventListener("input", refresh); });
  if (pick) pick.addEventListener("change", refresh);
  refresh();
})();
</script>`;

  return layout({
    title: `${project.name} · 抽样`,
    active: "projects",
    system,
    body: `${projectHeader(project, "sampling", noticeMessage)}
${metricGrid([
  metric({ label: "可抽样关键词", value: num(stats.enabled), hint: "来自本项目的关键词池，已启用的部分" }),
  metric({ label: "可用账号", value: num(usableCount), hint: `共 ${num(accounts.length)} 个账号` }),
  metric({ label: "历史批次", value: num(batches.length), hint: "批次保留当时抽中的关键词，不受后续改动影响" }),
])}
${
  usableCount === 0 && accounts.length > 0
    ? notice("当前没有「正常」状态的账号，无法创建批次。请先到「账号」页处理。", "warn")
    : ""
}
${panel("从本项目关键词池抽样", {
  hint: `当前可抽 ${num(stats.enabled)} 条`,
  body: `<div class="card-body pad">${form}</div>`,
})}
${panel(`本项目批次（${batches.length}）`, {
  body: dataTable({
    columns: [
      { label: "批次", render: (row) => `<a href="/batches/${row.id}">#${row.id} ${escapeHtml(truncate(row.name, 30))}</a>` },
      { label: "状态", render: (row) => badge(statusLabel(row.status), statusTone(row.status)) },
      {
        label: "抽样",
        render: (row) =>
          escapeHtml(`${row.sampling_method === "stratified" ? "分层" : "纯随机"} ${row.sample_size}/${row.pool_size} ×${row.repeats ?? 1}`),
      },
      { label: "账号", render: (row) => escapeHtml((row.account_keys ?? []).join(", ") || "—") },
      { label: "有效/总数", align: "right", render: (row) => `${num(row.valid_runs)} / ${num(row.runs_total)}` },
      { label: "RUN 提及率", align: "right", render: (row) => escapeHtml(pct(row.mentioned_runs, row.valid_runs)) },
      { label: "创建时间", className: "nowrap", render: (row) => dateTime(row.created_at) },
    ],
    rows: batches,
    empty: "还没有批次，用上面的表单抽取一次。",
  }),
})}`,
  });
}

/* ------------------------------------------------------------------ 项目下的运行与来源 */

export function projectRunsPage({ project, runs, system = null }) {
  return layout({
    title: `${project.name} · 运行记录`,
    active: "projects",
    system,
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

export function projectSourcesPage({ project, sources, system = null }) {
  return layout({
    title: `${project.name} · 引用来源`,
    active: "projects",
    system,
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

function accountStatusBadge(status) {
  return badge(ACCOUNT_STATUS_LABELS[status] ?? status ?? "未知", ACCOUNT_STATUS_TONES[status] ?? "muted");
}

/** 一句话说明这个账号现在为什么可用 / 不可用，区分自动恢复与需要人工。 */
function accountStatusText(account, dailyLimit = 60) {
  const group = accountGroupOf(account, { dailyLimit });
  if (group === "disabled") return "已禁用，不会收到任务";
  if (group === "manual_attention") {
    return ACCOUNT_STATUS_LABELS[account.status] ?? account.status ?? "需要人工处理";
  }
  const usedToday = account.runs_today ?? account.run_count_today;
  if (group === "auto_waiting") {
    if (account.cooldown_until) return `自动恢复，预计 ${dateTime(account.cooldown_until)}`;
    return `今日 ${num(usedToday)} / ${num(dailyLimit)}，已达上限，次日自动恢复`;
  }
  return `今日 ${num(usedToday)} / ${num(dailyLimit)}`;
}

/**
 * 账号页。核心是把「等一会儿自己会好」和「需要你去处理」彻底分开：
 * 把 cooldown 和 login_required 混在同一个「需要人工处理」里，会让操作者做无谓的操作。
 */
export function accountsPage({ accounts = [], notice: noticeMessage, system = null, dailyLimit = 60 }) {
  const groups = { healthy: [], auto_waiting: [], manual_attention: [], disabled: [] };
  for (const account of accounts) {
    groups[accountGroupOf(account, { dailyLimit })].push(account);
  }

  const accountTable = (rows, { actions }) =>
    dataTable({
      columns: [
        { label: "账号", render: (row) => `<code>${escapeHtml(row.account_key)}</code>` },
        { label: "状态", render: (row) => accountStatusBadge(row.status) },
        // 用 runs_today（限额计数）而不是 run_count_today（当日实际运行数）：
        // 这一列表达的是「离每日上限还有多远」，必须和限额判定用同一个计数。
        { label: "今日 / 上限", align: "right", render: (row) =>
            `${num(row.runs_today ?? row.run_count_today)} / ${num(dailyLimit)}` },
        { label: "累计运行", align: "right", render: (row) => num(row.run_count) },
        { label: "连续失败", align: "right", render: (row) => (row.consecutive_failures ? num(row.consecutive_failures) : "0") },
        { label: "最近运行", className: "nowrap", render: (row) => dateTime(row.last_run_at) },
        { label: "登录态", render: (row) => (row.storage_state_present ? badge("已保存", "ok") : badge("未保存", "warn")) },
        { label: "原因", render: (row) =>
            row.pause_reason
              ? escapeHtml(row.pause_reason)
              : row.last_error_code
                ? escapeHtml(errorCodeLabel(row.last_error_code))
                : "—" },
        { label: "操作", render: actions },
      ],
      rows,
      empty: "没有账号属于这一组。",
    });

  const healthyTable = accountTable(groups.healthy, {
    actions: (row) => `<div class="actions">
      ${formButton({
        action: `/accounts/${encodeURIComponent(row.account_key)}/toggle`,
        label: "禁用",
        tone: "danger",
        field: `<input type="hidden" name="enabled" value="false" />`,
        confirm: `确认禁用账号 ${row.account_key}？禁用后不会再向它派发任务。`,
      })}
    </div>`,
  });

  const waitingTable = accountTable(groups.auto_waiting, {
    actions: (row) => `<span class="hint" style="margin:0">
      预计恢复：${dateTime(row.cooldown_until) || "下一个自然日"}
    </span>`,
  });

  const manualTable = accountTable(groups.manual_attention, {
    actions: (row) => `<div class="actions">
      ${formButton({
        action: `/accounts/${encodeURIComponent(row.account_key)}/resume`,
        label: "恢复",
        tone: "secondary",
        confirm: `确认已将账号 ${row.account_key} 处理完毕（重新登录或完成人机验证）？`,
      })}
      ${formButton({
        action: `/accounts/${encodeURIComponent(row.account_key)}/toggle`,
        label: "禁用",
        tone: "danger",
        field: `<input type="hidden" name="enabled" value="false" />`,
        confirm: `确认禁用账号 ${row.account_key}？`,
      })}
    </div>`,
  });

  const disabledTable = accountTable(groups.disabled, {
    actions: (row) => `<div class="actions">
      ${formButton({
        action: `/accounts/${encodeURIComponent(row.account_key)}/toggle`,
        label: "启用",
        tone: "primary",
        field: `<input type="hidden" name="enabled" value="true" />`,
      })}
    </div>`,
  });

  const blocks = [];

  if (noticeMessage) blocks.push(notice(escapeHtml(noticeMessage)));

  blocks.push(
    metricGrid([
      metric({
        label: "正常",
        value: num(groups.healthy.length),
        hint: "可以直接派发任务",
        tone: groups.healthy.length ? "ok" : "warn",
      }),
      metric({
        label: "自动等待",
        value: num(groups.auto_waiting.length),
        hint: "冷却或额度用完，系统会自动恢复，无需人工操作",
        tone: groups.auto_waiting.length ? "warn" : "",
      }),
      metric({
        label: "需要人工处理",
        value: num(groups.manual_attention.length),
        hint: "登录失效或人机验证，必须在浏览器中人工完成",
        tone: groups.manual_attention.length ? "bad" : "ok",
      }),
      metric({
        label: "已禁用",
        value: num(groups.disabled.length),
        hint: "不会收到任何任务",
      }),
    ]),
  );

  if (groups.manual_attention.length) {
    blocks.push(
      notice(
        `<strong>${groups.manual_attention.length} 个账号需要人工处理</strong>：` +
          groups.manual_attention
            .map((account) => `${account.account_key}（${ACCOUNT_STATUS_LABELS[account.status] ?? account.status}）`)
            .join("、") +
          `。这些账号的自动任务已停止；处理完成后在本页点「恢复」。`,
        "bad",
      ),
    );
  }

  if (groups.auto_waiting.length) {
    blocks.push(
      notice(
        `${groups.auto_waiting.length} 个账号处于自动等待：` +
          groups.auto_waiting.map((account) => `${account.account_key}（${ACCOUNT_STATUS_LABELS[account.status] ?? account.status}）`).join("、") +
          `。系统会自动恢复，无需人工操作，相关任务会被延迟而不是丢弃。`,
        "warn",
      ),
    );
  }

  blocks.push(
    panel(`正常（${groups.healthy.length}）`, {
      hint: "可直接派发任务；单账号同时只允许一个豆包会话",
      body: healthyTable,
    }),
  );

  if (groups.auto_waiting.length) {
    blocks.push(
      panel(`自动等待（${groups.auto_waiting.length}）`, {
        hint: "系统自动恢复，不需要你操作",
        body: waitingTable,
      }),
    );
  }

  if (groups.manual_attention.length) {
    blocks.push(
      panel(`需要人工处理（${groups.manual_attention.length}）`, {
        hint: "登录失效 / 人机验证 / 访问受限，必须人工完成后才能继续",
        body: manualTable,
      }),
    );
  }

  if (groups.disabled.length) {
    blocks.push(
      panel(`已禁用（${groups.disabled.length}）`, {
        hint: "不会收到任何任务",
        body: disabledTable,
      }),
    );
  }

  if (!accounts.length) {
    blocks.push(
      panel("还没有账号", {
        body: emptyState("系统需要至少一个豆包账号才能派发提问。", {
          hint: "执行 npm run auth -- --account account_01 打开浏览器完成登录，登录态只保存在本地。",
        }),
      }),
    );
  }

  blocks.push(
    panel("状态语义与处理方式", {
      hint: "系统不会自动处理验证码，也不会尝试绕过平台限制",
      body: `<div class="card-body pad">
        <table><tbody>
          <tr><th style="width:170px">正常</th><td>可以派发任务。若你主动禁用，会归入「已禁用」。</td></tr>
          <tr><th>自动等待</th><td>冷却中 / 触发频率限制 / 当日额度用完。任务会被<strong>延迟</strong>到恢复时刻执行，不会丢；系统自行恢复，你不需要做任何事。</td></tr>
          <tr><th>需要人工处理</th><td>需要登录 / 登录态失效 / 需要人工验证 / 访问受限 / 人工暂停。自动任务立即停止，处理完点「恢复」。</td></tr>
          <tr><th>已禁用</th><td>不会收到任何任务。点「启用」后回到正常流程。</td></tr>
        </tbody></table>
        ${cmd("npm run auth -- --account account_01", "重新登录某个账号（会打开浏览器窗口，登录态保存在本地）")}
        ${cmd("npm run worker", "启动后台采集 Worker（独立进程）")}
      </div>`,
    }),
  );

  return layout({
    title: "账号",
    active: "accounts",
    system,
    body: `${pageHead({
      kicker: "账号",
      title: "账号",
      sub: "每个账号使用独立的浏览器 Profile。这里只展示派生状态与计数，不显示 Cookie 或完整登录态——登录凭据始终只保存在服务器本地的 .onegl/auth/accounts/ 目录里。",
    })}${blocks.join("")}`,
  });
}

/* ------------------------------------------------------------------ 系统状态 */

export function systemPage({ system, db, config = {} }) {
  const readiness = system?.readiness ?? { ready: false, blockers: [], warnings: [] };

  const blocks = [
    panel(readiness.ready ? "可以开始" : "未就绪", {
      tone: readiness.ready ? "" : "blocked",
      body: blockerList([
        ...readiness.blockers.map((item) => ({ tag: "阻塞", tone: "bad", label: item.label, detail: item.detail, fix: item.fix })),
        ...readiness.warnings.map((item) => ({ tag: "提醒", tone: "warn", label: item.label, detail: item.detail, fix: item.fix })),
      ]),
    }),
    panel("组件", {
      hint: "全部为真实探测结果，不只看环境变量是否存在",
      body: kvList([
        ["PostgreSQL", `${connectionText(system?.database?.state)}${system?.database?.message ? ` — ${escapeHtml(system.database.message)}` : ""}`],
        ["Redis", `${connectionText(system?.redis?.state)}${system?.redis?.message ? ` — ${escapeHtml(system.redis.message)}` : ""}${system?.redis?.latencyMs != null ? `（${system.redis.latencyMs} ms）` : ""}`],
        ["Worker", `${workerText(system?.worker?.state)}${system?.worker?.ageMs != null ? ` — 最近心跳 ${Math.round(system.worker.ageMs / 1000)} 秒前` : ""}`],
        ["Worker 进程", system?.worker?.heartbeat ? `pid ${system.worker.heartbeat.pid} @ ${escapeHtml(system.worker.heartbeat.hostname ?? "—")}` : "—"],
        ["Worker 启动时间", dateTime(system?.worker?.heartbeat?.startedAt)],
        ["Worker 监听账号", system?.worker?.heartbeat ? (system.worker.heartbeat.accounts ?? []).join("、") || "（无）" : "—"],
        ["可用账号", `${num(system?.accounts?.usable)} / ${num(system?.accounts?.total)}`],
        ["运行中批次", num((system?.activeBatches ?? []).length)],
        ["探测时间", dateTime(system?.at)],
      ]),
    }),
    panel("当前配置", {
      hint: "只显示非敏感的派生配置，不显示任何连接串、密码或登录态",
      body: kvList([
        ["Web 监听", `127.0.0.1:${escapeHtml(String(config.port ?? "—"))}（仅回环，无鉴权）`],
        ["数据目录", `<code>${escapeHtml(config.dataDir ?? "—")}</code>`],
        ["浏览器后端", escapeHtml(config.browser ?? "—")],
        ["豆包地址", escapeHtml(config.doubaoUrl ?? "—")],
        ["账号时区", escapeHtml(config.accountTimeZone ?? "—")],
        ["每日上限 / 冷却", `${num(config.dailyLimit)} 次 / ${num(config.cooldownMinutes)} 分钟`],
        ["账号并行度", num(config.parallelism)],
        ["Worker 心跳间隔", `${num(config.heartbeatIntervalSeconds)} 秒`],
        ["心跳在线阈值", `${num(config.heartbeatOnlineSeconds)} 秒内视为在线，超过 ${num(config.heartbeatDegradedSeconds)} 秒视为离线`],
      ]),
    }),
    panel("出问题时下一步去哪看", {
      body: `<div class="card-body pad">
        <table><tbody>
          <tr><th style="width:210px">Worker 离线</th><td>另开一个进程执行 <code>npm run worker</code>。批次页的「开始监测」会被禁用直到心跳恢复。</td></tr>
          <tr><th>Redis 不可用</th><td>本机通常先执行 <code>npm run db:tunnel</code>（Redis 也只监听服务器回环地址）。</td></tr>
          <tr><th>数据库不可用</th><td><code>npm run db:tunnel</code> → <code>npm run db:migrate</code>。</td></tr>
          <tr><th>批次没跑完</th><td>批次页看进度与失败原因；「运行记录」按错误码筛选。</td></tr>
          <tr><th>某条 Run 失败</th><td>运行详情页顶部就是错误码与 error_details，下面有 Attempt 时间线与每次尝试的截图。</td></tr>
          <tr><th>某账号不动了</th><td>「账号」页看它属于自动等待还是需要人工处理，两者处理方式不同。</td></tr>
        </tbody></table>
      </div>`,
    }),
  ];

  return layout({
    title: "系统",
    active: "system",
    system,
    body: `${pageHead({
      kicker: "系统",
      title: "系统状态",
      sub: "这里回答一个问题：现在点「开始监测」到底能不能跑。",
    })}${blocks.join("")}`,
  });
}

/* ------------------------------------------------------------------ 错误页 */

export function notFoundPage(pathname) {
  return layout({
    title: "页面不存在",
    body: `${pageHead({ kicker: "404", title: "页面不存在", sub: `找不到 ${escapeHtml(pathname)}。` })}<p><a class="linkbtn" href="/">返回总览</a></p>`,
  });
}

export function errorPage(message) {
  return layout({
    title: "服务异常",
    body: `${pageHead({ kicker: "500", title: "服务异常" })}${notice(escapeHtml(message), "bad")}`,
  });
}
