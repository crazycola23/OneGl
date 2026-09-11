import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCOUNT_GROUPS,
  CONNECTION_STATES,
  WORKER_STATES,
  accountGroupOf,
  classifyWorkerHeartbeat,
  runReadiness,
} from "../src/system/status.js";
import {
  accountsPage,
  batchPage,
  batchesPage,
  errorPage,
  homePage,
  notFoundPage,
  projectSamplingPage,
  projectsPage,
  runPage,
  runsPage,
  sourcesPage,
  systemPage,
} from "../src/ui/pages.js";
import { RunStore } from "../src/store.js";

/**
 * 操作台的离线渲染测试。
 *
 * 不启动服务、不连数据库、不碰真实豆包账号：用假数据把每个页面渲染一遍，
 * 断言「不抛异常」以及关键信息确实出现在 HTML 里。
 *
 * 注意：这里刻意不 import src/server.js —— 那个模块在导入时就会监听端口。
 */

/* ------------------------------------------------------------------ 假数据 */

const NOW = "2026-09-11T02:00:00.000Z";

function fakeSystem(overrides = {}) {
  const status = {
    at: NOW,
    database: { state: CONNECTION_STATES.CONNECTED, message: "" },
    redis: { state: CONNECTION_STATES.CONNECTED, message: "", latencyMs: 2 },
    worker: { state: WORKER_STATES.ONLINE, heartbeat: { at: NOW, pid: 1234, hostname: "test", accounts: ["account_01"] }, ageMs: 1000 },
    accounts: { total: 1, usable: 1, healthy: [], auto_waiting: [], manual_attention: [], disabled: [] },
    activeBatches: [],
    host: { hostname: "test", pid: 1 },
    ...overrides,
  };
  status.readiness = runReadiness(status);
  return status;
}

function fakeAccount(overrides = {}) {
  return {
    account_key: "account_01",
    provider: "doubao",
    enabled: true,
    status: "healthy",
    run_count: 12,
    run_count_today: 3,
    // runs_today 是驱动每日限额的计数（accounts 表列），分组判定以它为准
    runs_today: 3,
    consecutive_failures: 0,
    last_run_at: NOW,
    cooldown_until: null,
    pause_reason: null,
    last_error_code: null,
    storage_state_present: true,
    ...overrides,
  };
}

function fakeReport(batchOverrides = {}, overrides = {}) {
  return {
    batch: {
      id: 1,
      name: "测试批次",
      project_id: 1,
      project_name: "测试项目",
      target_brand: "测试品牌",
      provider: "doubao",
      status: "running",
      pool_version: "v1",
      pool_size: 10,
      sample_size: 5,
      sampling_method: "stratified",
      sampling_seed: "seed-1",
      account_keys: ["account_01"],
      repeats: 1,
      started_at: NOW,
      finished_at: null,
      created_at: NOW,
      queued_at: NOW,
      aborted_at: null,
      last_heartbeat_at: NOW,
      requested_jobs: 5,
      completed_jobs: 0,
      failed_jobs: 0,
      skipped_jobs: 0,
      ...batchOverrides,
    },
    runs: {
      assignmentsRun: 5,
      valid: 0,
      partial: 0,
      failed: 0,
      unconfirmedReset: 0,
      mentioned: 0,
      mentionRate: null,
      ...(overrides.runs ?? {}),
    },
    prompts: { total: 0, mentioned: 0, mentionCoverage: null, ...(overrides.prompts ?? {}) },
    citations: { total: 0, articles: 0, domains: 0, ...(overrides.citations ?? {}) },
    tracked: { total: 0, cited: 0, citationRate: null, articles: [], ...(overrides.tracked ?? {}) },
    topArticles: overrides.topArticles ?? [],
    topDomains: overrides.topDomains ?? [],
    byCategory: overrides.byCategory ?? [],
    byAccount: overrides.byAccount ?? [],
    failures: overrides.failures ?? [],
  };
}

const EMPTY_SOURCES = { domains: [], articles: [], totals: { citations: 0, articles: 0, domains: 0 } };

function assertHtml(html, label) {
  assert.equal(typeof html, "string", `${label}: 应当返回字符串`);
  assert.ok(html.startsWith("<!doctype html>"), `${label}: 应当是完整 HTML`);
  assert.ok(html.includes("</html>"), `${label}: HTML 应当闭合`);
}

/* ------------------------------------------------------ 系统状态纯逻辑 */

test("Worker 心跳按阈值分成 在线 / 心跳变慢 / 离线", () => {
  const now = Date.parse(NOW);
  assert.equal(classifyWorkerHeartbeat({ at: NOW }, now).state, WORKER_STATES.ONLINE);
  assert.equal(classifyWorkerHeartbeat({ at: new Date(now - 60_000).toISOString() }, now).state, WORKER_STATES.DEGRADED);
  assert.equal(classifyWorkerHeartbeat({ at: new Date(now - 120_000).toISOString() }, now).state, WORKER_STATES.OFFLINE);
  assert.equal(classifyWorkerHeartbeat(null, now).state, WORKER_STATES.OFFLINE);
});

test("账号分组：冷却属于自动等待，登录失效才需要人工处理", () => {
  const now = Date.now();
  assert.equal(accountGroupOf(fakeAccount({ status: "healthy" })), ACCOUNT_GROUPS.HEALTHY);
  assert.equal(
    accountGroupOf(
      fakeAccount({ status: "cooldown", cooldown_until: new Date(now + 600_000).toISOString() }),
    ),
    ACCOUNT_GROUPS.AUTO_WAITING,
  );
  assert.equal(accountGroupOf(fakeAccount({ status: "rate_limited" })), ACCOUNT_GROUPS.AUTO_WAITING);
  assert.equal(
    accountGroupOf(fakeAccount({ status: "healthy", runs_today: 60 }), { dailyLimit: 60 }),
    ACCOUNT_GROUPS.AUTO_WAITING,
  );
  for (const status of ["login_required", "session_expired", "verification_required", "access_restricted", "paused"]) {
    assert.equal(accountGroupOf(fakeAccount({ status })), ACCOUNT_GROUPS.MANUAL_ATTENTION, status);
  }
  assert.equal(accountGroupOf(fakeAccount({ enabled: false })), ACCOUNT_GROUPS.DISABLED);
});

test("就绪判断：Redis 不可用或 Worker 离线都会阻塞", () => {
  const ready = fakeSystem();
  assert.equal(ready.readiness.ready, true);

  const noWorker = fakeSystem({ worker: { state: WORKER_STATES.OFFLINE, heartbeat: null, ageMs: null } });
  assert.equal(noWorker.readiness.ready, false);
  assert.ok(noWorker.readiness.blockers.some((item) => item.key === "worker"));

  const noRedis = fakeSystem({ redis: { state: CONNECTION_STATES.UNREACHABLE, message: "ECONNREFUSED" } });
  assert.equal(noRedis.readiness.ready, false);
  assert.ok(noRedis.readiness.blockers.some((item) => item.key === "redis"));

  const noAccounts = fakeSystem({
    accounts: { total: 0, usable: 0, healthy: [], auto_waiting: [], manual_attention: [], disabled: [] },
  });
  assert.equal(noAccounts.readiness.ready, false);
  assert.ok(noAccounts.readiness.blockers.some((item) => item.key === "accounts"));
});

/* ---------------------------------------------------------------- 页面 */

test("总览：未就绪时列出阻塞项，无批次时给出下一步", () => {
  const system = fakeSystem({ worker: { state: WORKER_STATES.OFFLINE, heartbeat: null, ageMs: null } });
  const html = homePage({
    db: { ready: true, message: "" },
    system,
    overview: { projects: 0, prompts: 0, batches: 0, runs: 0, articles: 0, citations: 0 },
    batches: [],
    activeBatches: [],
    attention: [],
    recentFailures: [],
  });
  assertHtml(html, "总览");
  assert.ok(html.includes("系统尚未就绪"), "应当提示未就绪");
  assert.ok(html.includes("Worker 未在线"), "应当指出 Worker 未在线");
  assert.ok(html.includes("当前没有需要人工处理的问题。"), "无待办时应当明确说明");
  assert.ok(html.includes("去建项目"), "无批次时应当给出下一步");
});

test("总览：执行中的批次显示进度与心跳", () => {
  const html = homePage({
    db: { ready: true, message: "" },
    system: fakeSystem({
      activeBatches: [{ batch: { id: 7, name: "运行中的批次", status: "running", project_name: "测试项目", account_keys: ["account_01"], last_heartbeat_at: NOW } }],
    }),
    overview: { projects: 1, prompts: 10, batches: 1, runs: 2, articles: 1, citations: 3 },
    batches: [],
    activeBatches: [
      {
        batch: {
          id: 7,
          name: "运行中的批次",
          status: "running",
          project_name: "测试项目",
          account_keys: ["account_01"],
          last_heartbeat_at: NOW,
        },
        counts: { requested: 10, completed: 4, failed: 1, skipped: 0, active: 1, waiting: 4, done: 5, percent: 50 },
      },
    ],
    attention: [],
    recentFailures: [],
  });
  assertHtml(html, "总览执行中");
  assert.ok(html.includes("正在执行（1）"));
  assert.ok(html.includes("最后心跳"));
});

test("账号页：四种分组各自出现，冷却不提供恢复按钮", () => {
  const accounts = [
    fakeAccount({ account_key: "acc_healthy", status: "healthy" }),
    fakeAccount({ account_key: "acc_cooldown", status: "cooldown", cooldown_until: new Date(Date.now() + 600_000).toISOString() }),
    fakeAccount({ account_key: "acc_login", status: "login_required", pause_reason: "登录态已失效" }),
    fakeAccount({ account_key: "acc_disabled", enabled: false, status: "disabled" }),
  ];
  const html = accountsPage({ accounts, dailyLimit: 60 });

  assertHtml(html, "账号页");
  for (const key of accounts.map((row) => row.account_key)) {
    assert.ok(html.includes(key), `应当列出 ${key}`);
  }
  assert.ok(html.includes("正常（1）"));
  assert.ok(html.includes("自动等待（1）"));
  assert.ok(html.includes("需要人工处理（1）"));
  assert.ok(html.includes("已禁用（1）"));
  assert.ok(html.includes("系统会自动恢复，无需人工操作"), "冷却必须说明会自动恢复");
  assert.ok(html.includes("预计恢复"), "冷却应当给出预计恢复时间");
  // 冷却账号所在分组不应出现恢复按钮
  const waitingSection = html.split("自动等待（1）")[1].split("需要人工处理（1）")[0];
  assert.ok(!waitingSection.includes(">恢复<"), "冷却账号不应显示恢复按钮");
});

test("账号页：没有账号时说明下一步", () => {
  const html = accountsPage({ accounts: [] });
  assertHtml(html, "账号页空状态");
  assert.ok(html.includes("还没有账号"));
  assert.ok(html.includes("npm run auth"), "应当告诉操作者怎么建账号");
});

test("批次页：六种状态都能渲染，且未就绪时开始按钮被禁用", () => {
  for (const status of ["pending", "queued", "running", "completed", "partial", "failed", "aborted"]) {
    const html = batchPage({
      report: fakeReport({ status }),
      runs: [],
      sources: EMPTY_SOURCES,
      progress: null,
      queueReady: true,
      system: fakeSystem(),
    });
    assertHtml(html, `批次 ${status}`);
    assert.ok(html.includes("执行控制"), `${status}: 应当有执行控制区`);
  }

  const offline = batchPage({
    report: fakeReport({ status: "pending" }),
    runs: [],
    sources: EMPTY_SOURCES,
    progress: null,
    queueReady: true,
    system: fakeSystem({ worker: { state: WORKER_STATES.OFFLINE, heartbeat: null, ageMs: null } }),
  });
  assert.ok(offline.includes("Worker 未在线，请先启动 npm run worker"), "应当说明为什么不能开始");
  assert.ok(offline.includes("disabled"), "开始按钮应当被禁用");
  assert.ok(!offline.includes("确认开始监测"), "不能开始时不应弹出确认");

  const ready = batchPage({
    report: fakeReport({ status: "pending" }),
    runs: [],
    sources: EMPTY_SOURCES,
    progress: null,
    queueReady: true,
    system: fakeSystem(),
  });
  assert.ok(ready.includes("确认开始监测"), "就绪时开始按钮必须带确认");
  assert.ok(!ready.includes("disabled title"), "就绪时按钮不应被禁用");
});

test("批次页：开始确认里写明真实任务量", () => {
  const html = batchPage({
    report: fakeReport({ status: "pending", sample_size: 20, repeats: 2, requested_jobs: 40, account_keys: ["account_01", "account_02"] }),
    runs: [],
    sources: EMPTY_SOURCES,
    progress: null,
    queueReady: true,
    system: fakeSystem(),
  });
  assert.ok(html.includes("抽样 20 条 × 重复 2 次"), "确认信息应当写清抽样与重复");
  assert.ok(html.includes("40 个任务"), "确认信息应当写清最终任务数");
  assert.ok(html.includes("2 个账号"), "确认信息应当写清账号数");
});

test("批次页：进度与样本口径在无进度数据时也能渲染", () => {
  const html = batchPage({
    report: fakeReport(
      { status: "partial" },
      { runs: { assignmentsRun: 10, valid: 6, partial: 3, failed: 4, unconfirmedReset: 0, mentioned: 2, mentionRate: 0.3 }, failures: [{ error_code: "CITATION_PARSE_FAILED", runs: "3" }] },
    ),
    runs: [
      { local_run_id: "run_b1_i1", status: "failed", error_code: "DOUBAO_TIMEOUT", attempt: 2, account_key: "account_01", conversation_reset_confirmed: false, prompt: "问题", captured_citation_count: 0, expected_citation_count: null },
    ],
    sources: EMPTY_SOURCES,
    progress: { counts: { requested: 10, completed: 6, failed: 4, skipped: 0, active: 0, waiting: 0, done: 10, percent: 100 } },
    queueReady: true,
    system: fakeSystem(),
  });
  assertHtml(html, "批次 partial");
  assert.ok(html.includes("失败原因"));
  assert.ok(html.includes("样本口径"));
  assert.ok(html.includes("命令行与复现"), "命令行应当被定位为高级手段");
});

test("运行列表：筛选与失败高亮", () => {
  const html = runsPage({
    db: { ready: true, message: "" },
    system: fakeSystem(),
    runs: [
      { id: 1, local_run_id: "run_a", status: "failed", attempt: 2, error_code: "DOUBAO_TIMEOUT", account_key: "account_01", project_name: "测试项目", sampling_batch_id: 3, prompt: "问题", answer_chars: 0, captured_citation_count: 0, expected_citation_count: 5, conversation_reset_confirmed: false, started_at: NOW },
      { id: 2, local_run_id: "run_b", status: "success", attempt: 1, error_code: null, account_key: "account_01", project_name: "测试项目", sampling_batch_id: 3, prompt: "问题2", answer_chars: 120, captured_citation_count: 5, expected_citation_count: 5, conversation_reset_confirmed: true, started_at: NOW },
    ],
    projects: [{ id: 1, name: "测试项目" }],
    accounts: ["account_01"],
    batches: [{ id: 3, name: "批次" }],
    errorCodes: [{ code: "DOUBAO_TIMEOUT", runs: 1 }],
    filters: { status: "failed", projectId: "1" },
    localRuns: [],
  });
  assertHtml(html, "运行列表");
  assert.ok(html.includes("row-bad"), "失败行应当高亮");
  assert.ok(html.includes("Attempt"), "应当展示 attempt 列");
  assert.ok(html.includes('name="account"'), "应当有账号筛选");
  assert.ok(html.includes('name="error"'), "应当有错误码筛选");
  assert.ok(html.includes("DOUBAO_TIMEOUT"), "筛选下拉应当列出错误码");
});

test("运行详情：三种状态都能渲染，失败时错误与详情在最前", () => {
  for (const status of ["success", "partial", "failed"]) {
    const html = runPage({
      db: { ready: true, message: "" },
      system: fakeSystem(),
      runId: "run_b1_i1",
      run: {
        id: 1,
        local_run_id: "run_b1_i1",
        status,
        attempt: 2,
        account_key: "account_01",
        project_name: "测试项目",
        sampling_batch_id: 3,
        prompt: "绍兴正骨哪家好？",
        answer: "回答正文",
        provider: "doubao",
        citation_state: "parse_failed",
        submission_method: "enter_key",
        started_at: NOW,
        finished_at: NOW,
        captured_citation_count: 15,
        expected_citation_count: 18,
        conversation_reset_confirmed: true,
        error_code: status === "failed" ? "DOUBAO_TIMEOUT" : null,
        error_message: status === "failed" ? "等待回答超时" : null,
        error_details: status === "failed" ? { phase: "waitForAnswer" } : null,
        artifact_path: ".onegl/runs/run_b1_i1/attempts/2",
      },
      citations: [
        { source_position: 1, title: "文章", original_url: "https://example.com/a", canonical_url: "https://example.com/a", normalized_domain: "example.com", relation_status: "matched", captured_from: "DOM", source_type: "visible", visible_to_user: true, tracked_article_id: null },
      ],
      localRun: { status, attempt: 2, attempts: [1, 2], attemptHistory: [{ attempt: 1, status: "failed", errorCode: "RATE_LIMITED" }], artifactPath: ".onegl/runs/run_b1_i1/attempts/2" },
      attempts: [
        { attempt: 1, dir: ".onegl/runs/run_b1_i1/attempts/1", files: ["screenshot.png", "page.html"] },
        { attempt: 2, dir: ".onegl/runs/run_b1_i1/attempts/2", files: ["screenshot.png", "page.html", "answer.md"] },
      ],
      rootArtifacts: [],
    });
    assertHtml(html, `运行详情 ${status}`);
    assert.ok(html.includes("Attempt 历史（2）"), `${status}: 应当展示 attempt 时间线`);
    assert.ok(html.includes("attempts/1/screenshot.png"), `${status}: 应当给出 attempt 1 的产物链接`);
    assert.ok(html.includes("引用核对"), `${status}: 应当有引用核对区`);
    assert.ok(html.includes("可见引用"), `${status}: 应当有可见引用表`);
  }

  const failed = runPage({
    db: { ready: true, message: "" },
    system: fakeSystem(),
    runId: "run_b1_i1",
    run: {
      id: 1,
      local_run_id: "run_b1_i1",
      status: "failed",
      attempt: 2,
      project_name: "测试项目",
      prompt: "p",
      answer: null,
      started_at: NOW,
      finished_at: NOW,
      captured_citation_count: 0,
      conversation_reset_confirmed: false,
      error_code: "DOUBAO_CONVERSATION_RESET_FAILED",
      error_message: "无法确认新会话",
      error_details: { clickedNewConversation: false },
    },
    citations: [],
    localRun: null,
    attempts: [],
  });
  assert.ok(failed.includes("DOUBAO_CONVERSATION_RESET_FAILED"), "失败必须显示原始错误码");
  assert.ok(failed.includes("error_details"), "应当单独展示 error_details");
  assert.ok(
    failed.indexOf("DOUBAO_CONVERSATION_RESET_FAILED") < failed.indexOf("可见引用"),
    "错误信息必须在引用表之前",
  );
});

test("运行详情：旧产物布局也能给出调试链接", () => {
  const html = runPage({
    db: { ready: true, message: "" },
    system: fakeSystem(),
    runId: "run_legacy",
    run: {
      id: 9,
      local_run_id: "run_legacy",
      status: "success",
      attempt: 1,
      project_name: "测试项目",
      prompt: "问题",
      answer: "回答",
      started_at: NOW,
      finished_at: NOW,
      captured_citation_count: 1,
      expected_citation_count: 1,
      conversation_reset_confirmed: true,
    },
    citations: [],
    localRun: { status: "success", attempt: 1, attempts: [1], debugPath: ".onegl/runs/run_legacy" },
    attempts: [],
    rootArtifacts: ["answer.md", "screenshot.png"],
  });
  assertHtml(html, "运行详情旧布局");
  assert.ok(html.includes("旧产物布局"), "应当说明这是旧布局");
  assert.ok(html.includes("/artifacts/run_legacy/screenshot.png"), "应当给出根目录产物链接");
  assert.ok(!html.includes("本次运行还没有落地产物目录"), "有产物时不应显示空状态");
});

test("空状态：让操作者知道下一步做什么", () => {
  const runsEmpty = runsPage({
    db: { ready: true, message: "" },
    system: fakeSystem(),
    runs: [],
    projects: [],
    accounts: [],
    batches: [],
    errorCodes: [],
    filters: {},
    localRuns: [],
  });
  assert.ok(runsEmpty.includes("没有符合条件的运行记录"));

  const sourcesEmpty = sourcesPage({
    db: { ready: true, message: "" },
    system: fakeSystem(),
    sources: EMPTY_SOURCES,
    projects: [],
    projectId: null,
  });
  assert.ok(sourcesEmpty.includes("source_type = visible"), "引用来源页必须写清口径");
  assert.ok(sourcesEmpty.includes("还没有引用数据"));

  const batchEmpty = batchPage({
    report: fakeReport({ status: "pending" }),
    runs: [],
    sources: EMPTY_SOURCES,
    progress: null,
    queueReady: true,
    system: fakeSystem(),
  });
  assert.ok(batchEmpty.includes("该批次还没有运行记录"));

  const samplingEmpty = projectSamplingPage({
    project: { id: 1, name: "测试项目", description: null },
    batches: [],
    accounts: [],
    stats: { enabled: 0, total: 0, deleted: 0 },
    notice: null,
    system: fakeSystem(),
  });
  assert.ok(samplingEmpty.includes("尚未配置账号"), "没有账号时抽样页要说明");
});

test("抽样页：账号是选择项，阻塞账号被禁用", () => {
  const html = projectSamplingPage({
    project: { id: 1, name: "测试项目", description: null },
    batches: [],
    accounts: [
      fakeAccount({ account_key: "acc_ok", status: "healthy" }),
      fakeAccount({ account_key: "acc_cooldown", status: "cooldown", cooldown_until: new Date(Date.now() + 300_000).toISOString() }),
      fakeAccount({ account_key: "acc_login", status: "login_required" }),
    ],
    stats: { enabled: 30, total: 30, deleted: 0 },
    notice: null,
    system: fakeSystem(),
  });
  assertHtml(html, "抽样页");
  assert.ok(html.includes('type="checkbox"'), "账号应当是复选框而不是文本框");
  assert.ok(!html.includes('name="accounts" value="acc_ok" required'), "不应再要求手打账号名");
  assert.ok(html.includes("最终任务数"), "应当在创建前给出最终任务数");
  assert.ok(html.includes("高级选项"), "种子应当收进高级选项");
  // 阻塞账号被禁用：disabled 出现在该账号对应的 input 上
  const cooldownRow = html.split("acc_cooldown")[1].split("</label>")[0];
  assert.ok(cooldownRow.includes("disabled"), "冷却账号应当在选择项里被禁用");
  // 可用账号默认勾选
  const okRow = html.split("acc_ok")[1].split("</label>")[0];
  assert.ok(okRow.includes("checked"), "正常账号应当默认勾选");
});

test("其它页面在假数据下都能渲染", () => {
  const system = fakeSystem();
  assertHtml(systemPage({ system, db: { ready: true }, config: { port: 3100, dataDir: ".onegl", browser: "camoufox", doubaoUrl: "https://www.doubao.com/chat/", accountTimeZone: "Asia/Shanghai", dailyLimit: 60, cooldownMinutes: 30, parallelism: 1, heartbeatIntervalSeconds: 10, heartbeatOnlineSeconds: 30, heartbeatDegradedSeconds: 90 } }), "系统页");
  assertHtml(batchesPage({ db: { ready: true }, batches: [], projects: [], projectId: null, system }), "批次列表");
  assertHtml(projectsPage({ db: { ready: true }, projects: [], notice: null, system }), "项目列表");
  assertHtml(notFoundPage("/x"), "404");
  assertHtml(errorPage("boom"), "500");
});

/* ------------------------------------------------- artifact 路径安全 */

test("artifact 路径解析：只允许运行目录内的合法文件", () => {
  const store = new RunStore({ dataDir: "./.onegl-test" });
  const runId = "run_b1_i1";

  assert.ok(store.resolveArtifact(runId, ["screenshot.png"]));
  assert.ok(store.resolveArtifact(runId, ["attempts", "1", "screenshot.png"]));
  assert.ok(store.resolveArtifact(runId, ["attempts", "12", "citations.json"]));

  // 目录穿越
  assert.equal(store.resolveArtifact(runId, ["..", "..", "secret.txt"]), null);
  assert.equal(store.resolveArtifact(runId, ["attempts", "..", "run.json"]), null);
  // 非法片段
  assert.equal(store.resolveArtifact(runId, ["a/b", "c"]), null);
  assert.equal(store.resolveArtifact(runId, ["*.png"]), null);
  // 形状不对
  assert.equal(store.resolveArtifact(runId, []), null);
  assert.equal(store.resolveArtifact(runId, ["attempts", "1"]), null);
  assert.equal(store.resolveArtifact(runId, ["attempts", "abc", "x.png"]), null);
  assert.equal(store.resolveArtifact(runId, ["a", "b"]), null);
  // 非法 runId
  assert.equal(store.resolveArtifact("../../etc", ["passwd"]), null);
});
