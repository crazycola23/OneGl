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

export function batchPage({ report, runs, sources }) {
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

export function projectsPage({ db, projects }) {
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
<p class="lead">一个项目对应一个监控主题与一个目标品牌。</p>
${panel(`项目（${projects.length}）`, {
  body: dataTable({
    columns: [
      { label: "项目", render: (row) => `<a href="/projects/${row.id}">${escapeHtml(row.name)}</a>` },
      { label: "目标品牌", render: (row) => escapeHtml(row.target_brand ?? "—") },
      { label: "关键词池", align: "right", render: (row) => `${num(row.pool_enabled)} / ${num(row.pool_size)}` },
      { label: "批次", align: "right", render: (row) => num(row.batch_count) },
      { label: "运行", align: "right", render: (row) => num(row.run_count) },
      { label: "引用", align: "right", render: (row) => num(row.citation_count) },
      { label: "监控文章", align: "right", render: (row) => num(row.tracked_count) },
      { label: "创建时间", className: "nowrap", render: (row) => dateTime(row.created_at) },
    ],
    rows: projects,
    empty: "还没有项目。执行 npm run project:init -- --file <配置文件> 创建。",
  }),
})}`,
  });
}

export function projectPage({ project, pool, tracked, accounts }) {
  const aliases = (project.brand_aliases ?? []).map((term) => `<span class="term">${escapeHtml(term)}</span>`).join(" ") || "—";
  const products = (project.brand_product_aliases ?? []).map((term) => `<span class="term">${escapeHtml(term)}</span>`).join(" ") || "—";
  const excludes = (project.brand_exclude_patterns ?? []).map((term) => `<code>${escapeHtml(term)}</code>`).join(" ") || "—";

  const poolTotal = pool.reduce((sum, row) => sum + Number(row.prompts), 0);

  return layout({
    title: project.name,
    active: "projects",
    dbState: "数据库已连接",
    body: `<h1>${escapeHtml(project.name)}</h1>
<p class="lead">${escapeHtml(project.description ?? "（无描述）")}</p>
${metricGrid([
  metric({ label: "目标品牌", value: project.target_brand ?? "未配置" }),
  metric({ label: "关键词池", value: num(poolTotal), hint: `${pool.length} 个分类` }),
  metric({ label: "监控文章", value: num(tracked.length), hint: `${tracked.filter((row) => Number(row.citations) > 0).length} 篇已被引用过` }),
  metric({ label: "账号", value: num(accounts.length), hint: accounts.map((row) => row.account_key).join(", ") || "未配置" }),
])}
${panel("品牌识别规则", {
  hint: "第一阶段为规则检测，原始回答始终保留以便人工审计",
  body: kvList([
    ["品牌别名", aliases],
    ["产品名", products],
    ["排除模式", excludes],
    ["命中规则", "重叠时保留最长匹配；排除模式覆盖的区域先被抹除再匹配"],
  ]),
})}
${panel(`关键词池（${num(poolTotal)}）`, {
  hint: "分层抽样按各分类占比按比例分配",
  body: dataTable({
    columns: [
      { label: "分类", render: (row) => escapeHtml(row.category) },
      { label: "Prompt 数", align: "right", render: (row) => num(row.prompts) },
      { label: "启用", align: "right", render: (row) => num(row.enabled) },
      { label: "池版本", render: (row) => escapeHtml(row.pool_version ?? "—") },
    ],
    rows: pool,
    empty: "关键词池为空。",
  }),
})}
${panel(`监控文章（${tracked.length}）`, {
  hint: "canonical URL 精确匹配；命中后可直接查看被哪些问题、哪些账号引用",
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
