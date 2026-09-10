import "dotenv/config";
import { readFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { launchBrowserSession } from "./browser.js";
import {
  executeDoubaoPrompt,
  inspectSession,
  openDoubao,
  waitForManualLogin,
} from "./doubao.js";
import {
  ErrorCode,
  normalizeError,
  SESSION_BLOCKING_CODES,
} from "./errors.js";
import { RunStore } from "./store.js";
import { captureDomObservation } from "./dom-observer.js";
import { createPool, isDatabaseConfigured } from "./db/pool.js";
import { ensureAccounts, persistRun } from "./db/persist.js";
import { printBatchReport, buildBatchReport } from "./db/report.js";
import { BRAND_DETECTION_VERSION, compileBrandRules, detectBrandMention } from "./brand/detect.js";
import { applyProjectConfig, loadBrandRules, loadProjectConfig } from "./project/init.js";
import {
  createSamplingBatch,
  loadBatch,
  loadBatchAssignments,
  markBatchStatus,
  persistAssignmentRun,
} from "./sampling/batch.js";
import { parseAccountKeys, normalizeAccountKey } from "./accounts/registry.js";

// ---------------------------------------------------------------------------
// PostgreSQL persistence
//
// Optional by design: without DATABASE_URL the collector keeps working in
// artifact-only mode, so the Phase 0 local workflow is unaffected.
// ---------------------------------------------------------------------------

let sharedPool = null;
let databaseFailures = 0;

const STATUS_TEXT = {
  running: "执行中",
  success: "成功",
  partial: "部分成功",
  failed: "失败",
};

function statusText(status) {
  return STATUS_TEXT[status] ?? status;
}

function brandText(mentioned) {
  if (mentioned === true) return "已提及品牌";
  if (mentioned === false) return "未提及品牌";
  return "未检测品牌";
}

function getPool() {
  if (!isDatabaseConfigured()) return null;
  if (!sharedPool) sharedPool = createPool();
  return sharedPool;
}

async function closePool() {
  if (!sharedPool) return;
  await sharedPool.end().catch(() => undefined);
  sharedPool = null;
}

async function persistToDatabase(store, saved, { project, promptMeta }) {
  const pool = getPool();
  if (!pool) return;

  try {
    const summary = await persistRun({
      pool,
      run: saved,
      project,
      prompt: promptMeta,
      artifactPath: saved.debugPath ?? null,
    });
    await store.updateRun(saved.id, { dbStatus: "success", db: summary });
    console.log(
      `${saved.id}: 已写入数据库 | 数据库ID=${summary.runId} ` +
        `文章=${summary.articlesReferenced}（新增 ${summary.articlesCreated}） ` +
        `引用=${summary.citationsWritten}` +
        (summary.trackedCitations ? ` 命中监控文章=${summary.trackedCitations}` : ""),
    );
  } catch (error) {
    databaseFailures += 1;
    await store
      .updateRun(saved.id, {
        dbStatus: "failed",
        dbError: { name: error.name, message: error.message },
      })
      .catch(() => undefined);
    // Local debug artifacts are deliberately kept so the run stays auditable.
    console.error(`${saved.id}: 数据库写入失败 | ${error.message}`);
  }
}

/**
 * Brand rules live on the Project row. A project that was never configured for brand
 * monitoring simply has none, and the run records no verdict rather than a false one.
 */
async function brandRulesFor(projectName) {
  const pool = getPool();
  if (!pool) return null;
  try {
    const { brand } = await loadBrandRules(pool, projectName);
    if (!brand.name) return null;
    return compileBrandRules(brand);
  } catch {
    return null;
  }
}

function applyBrandDetection(rules, answer) {
  if (!rules) {
    return {
      brandMentioned: null,
      mentionCount: null,
      firstMentionPosition: null,
      matchedTerms: [],
      brandDetectionVersion: null,
    };
  }
  const result = detectBrandMention(answer, rules);
  return {
    brandMentioned: result.mentioned,
    mentionCount: result.mentionCount,
    firstMentionPosition: result.firstMentionPosition,
    matchedTerms: result.matchedTerms,
    brandDetectionVersion: result.version,
  };
}

function parseArgs(tokens) {
  const args = { _: [] };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = tokens[index + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function printHelp() {
  console.log(`OneGl 豆包引用情报

一、采集
  npm run auth  -- --account account_01
      打开浏览器窗口完成豆包登录，登录态按账号保存到 .onegl/auth/accounts/
  npm run run   -- --prompt "你的问题" [--project "项目名"] [--account account_01]
      向豆包提一个问题，抓取回答与可见引用
  npm run runs
      查看最近 30 条运行记录
  npm run serve
      启动只读分析界面 http://127.0.0.1:3100

二、可见度监测（需要 DATABASE_URL）
  npm run project:init -- --file examples/project.xiaomi.json
      创建/更新项目：目标品牌与别名规则、关键词池、账号、监控文章
  npm run pool:list    -- --project "小米汽车"
      查看关键词池的分类分布
  npm run sample       -- --project "小米汽车" --size 100 --method stratified \\
                          --accounts account_01 [--seed 20260910-ab12] [--repeats 1]
      从池中抽样并分配账号；记录 seed 与池版本，可完整复现
  npm run batch:run    -- --batch 1 [--delay-ms 6000] [--limit 10]
      执行批次：逐条新建对话、真实提问、识别品牌提及、写入数据库
  npm run report       -- --batch 1 [--json]
      输出批次报告：RUN 级与 PROMPT 级提及率、引用率、域名分布、分类与账号拆分

三、数据库
  npm run db:migrate / db:status / db:tunnel / db:query

数据库只监听服务器回环地址，本机需先执行 npm run db:tunnel 建立隧道。
账号凭据只保存在 .onegl/auth/accounts/ 下的文件里，不会写入数据库或仓库。`);
}

async function captureArtifacts(store, runId, page, prompt = null) {
  if (!page) return;
  try {
    await store.writeArtifact(runId, "page.html", await page.content());
  } catch {
    // Debug capture must never hide the primary run error.
  }
  try {
    await store.writeArtifact(
      runId,
      "screenshot.png",
      await page.screenshot({ fullPage: true }),
    );
  } catch {
    // Same rule as above.
  }
  try {
    const observation = await captureDomObservation(page, { prompt });
    await store.writeArtifact(
      runId,
      "dom-observation.json",
      `${JSON.stringify(observation, null, 2)}\n`,
    );
  } catch {
    // Structured DOM evidence is diagnostic only; never mask the primary result.
  }
}

async function executeOne({
  page,
  store,
  config,
  prompt,
  project,
  validation = null,
  context = {},
}) {
  const run = await store.createRun({
    prompt,
    project,
    accountKey: context.accountKey ?? null,
    samplingBatchId: context.samplingBatchId ?? null,
  });
  if (validation) await store.updateRun(run.id, { validation });
  try {
    const result = await executeDoubaoPrompt(page, prompt, config);
    await captureArtifacts(store, run.id, page, prompt);
    await store.writeArtifact(run.id, "answer.md", `${result.answer}\n`);
    await store.writeArtifact(
      run.id,
      "citations.json",
      `${JSON.stringify(result.citations, null, 2)}\n`,
    );

    const partial = result.citationState === "parse_failed";
    const saved = await store.updateRun(run.id, {
      status: partial ? "partial" : "success",
      completedAt: new Date().toISOString(),
      answer: result.answer,
      citations: result.citations,
      citationState: result.citationState,
      expectedCitationCount: result.expectedCitationCount,
      citationDiagnostics: result.citationDiagnostics,
      submissionMethod: result.submissionMethod,
      conversationReset: result.conversationReset,
      conversationResetConfirmed: result.conversationResetConfirmed ?? null,
      currentUrl: result.currentUrl,
      ...applyBrandDetection(context.brandRules ?? null, result.answer),
      errorCode: partial ? ErrorCode.CITATION_PARSE_FAILED : null,
      errorMessage: partial
        ? "The answer was captured, but visible citation extraction did not match the UI evidence."
        : null,
    });

    console.log(
      `${saved.id}: ${statusText(saved.status)} | ${brandText(saved.brandMentioned)} | 引用=${saved.citations.length}` +
        (saved.expectedCitationCount == null
          ? ""
          : `/${saved.expectedCitationCount}`),
    );
    await persistToDatabase(store, saved, {
      project,
      promptMeta: validation ? { externalId: validation.caseId ?? null } : null,
    });
    return saved;
  } catch (error) {
    await captureArtifacts(store, run.id, page, prompt);
    const normalized = normalizeError(error);
    const partialAnswer = normalized.details?.partialAnswer || null;
    await store.writeArtifact(run.id, "answer.md", partialAnswer ? `${partialAnswer}\n` : "");
    await store.writeArtifact(run.id, "citations.json", "[]\n");
    if (partialAnswer) {
      await store.writeArtifact(run.id, "partial-answer.md", `${partialAnswer}\n`);
    }
    const saved = await store.updateRun(run.id, {
      status: "failed",
      completedAt: new Date().toISOString(),
      answer: partialAnswer,
      errorCode: normalized.code,
      errorMessage: normalized.message,
      errorDetails: normalized.details,
      currentUrl: page?.url?.() || null,
    });
    console.error(`${saved.id}: 失败 | ${saved.errorCode}: ${saved.errorMessage}`);
    await persistToDatabase(store, saved, {
      project,
      promptMeta: validation ? { externalId: validation.caseId ?? null } : null,
    });
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      runId: saved.id,
      normalized,
    });
  }
}

async function waitForSettledSession(page, config) {
  // Doubao can render the chat textarea before its login button, so a single check
  // right after load can report "healthy" while the session is still anonymous and
  // save an unauthenticated storageState. Require the healthy state to hold across
  // several polls before trusting it.
  const required = Math.max(config.stablePolls, 3);
  const deadline = Date.now() + 60_000;
  let state = await inspectSession(page);
  let streak = state.state === "healthy" ? 1 : 0;
  while (streak < required && Date.now() < deadline) {
    // A definitive login/verification state needs user action, so stop polling and
    // hand over to waitForManualLogin instead of burning the settle window.
    if (state.state !== "healthy" && state.state !== "unknown") break;
    await page.waitForTimeout(config.pollMs);
    state = await inspectSession(page);
    streak = state.state === "healthy" ? streak + 1 : 0;
  }
  return state;
}

async function authCommand(args = {}) {
  const accountKey =
    typeof args.account === "string" ? normalizeAccountKey(args.account) : null;
  const config = loadConfig({ headless: false, accountKey });
  const session = await launchBrowserSession(config, { forceHeadful: true });
  try {
    await openDoubao(session.page, config);
    const initial = await waitForSettledSession(session.page, config);
    if (initial.state !== "healthy") {
      console.log(
        `请在刚打开的浏览器窗口中完成豆包登录${accountKey ? `（账号 ${accountKey}）` : ""}，程序会自动检测到可用的会话。`,
      );
      await waitForManualLogin(session.page, config);
    }
    await session.saveAuth();
    console.log(
      `豆包登录态已保存到 ${config.authStatePath}${accountKey ? `（账号 ${accountKey}）` : ""}`,
    );
  } finally {
    await session.close();
  }
}

async function runCommand(args) {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt) throw new Error("--prompt is required");
  const project = typeof args.project === "string" ? args.project : "default";
  const accountKey =
    typeof args.account === "string" ? normalizeAccountKey(args.account) : null;
  const config = loadConfig({ accountKey });
  const store = new RunStore(config);
  const brandRules = await brandRulesFor(project);
  const session = await launchBrowserSession(config);
  try {
    await openDoubao(session.page, config);
    await executeOne({
      page: session.page,
      store,
      config,
      prompt,
      project,
      context: { accountKey, brandRules },
    });
  } finally {
    await session.close();
  }
}

function normalizePromptFile(payload, args) {
  if (Array.isArray(payload)) {
    return {
      project: typeof args.project === "string" ? args.project : "default",
      prompts: payload.map((item, index) =>
        typeof item === "string"
          ? { id: `prompt_${index + 1}`, text: item, enabled: true }
          : item,
      ),
    };
  }

  if (payload && typeof payload === "object" && Array.isArray(payload.prompts)) {
    return {
      project:
        typeof args.project === "string"
          ? args.project
          : payload.project || "default",
      prompts: payload.prompts,
    };
  }

  throw new Error("Prompt file must be a JSON array or { project, prompts } object");
}

async function batchCommand(args) {
  if (typeof args.file !== "string") throw new Error("--file is required");
  const delayMs = Number(args["delay-ms"] ?? 5_000);
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("--delay-ms must be >= 0");

  const payload = JSON.parse(await readFile(args.file, "utf8"));
  const batch = normalizePromptFile(payload, args);
  const prompts = batch.prompts
    .filter((item) => item && item.enabled !== false)
    .map((item, index) =>
      typeof item === "string"
        ? { id: `prompt_${index + 1}`, text: item, enabled: true }
        : item,
    )
    .filter((item) => typeof item?.text === "string" && item.text.trim())
    .map((item) => ({ ...item, text: item.text.trim() }));

  const accountKey =
    typeof args.account === "string" ? normalizeAccountKey(args.account) : null;
  const config = loadConfig({ accountKey });
  const store = new RunStore(config);
  const brandRules = await brandRulesFor(batch.project);
  const session = await launchBrowserSession(config);
  let success = 0;
  let partial = 0;
  let failed = 0;
  try {
    await openDoubao(session.page, config);
    for (let index = 0; index < prompts.length; index += 1) {
      try {
        const run = await executeOne({
          page: session.page,
          store,
          config,
          prompt: prompts[index].text,
          project: batch.project,
          context: { accountKey, brandRules },
          validation: {
            caseId: prompts[index].id || `prompt_${index + 1}`,
            targetScenario: prompts[index].targetScenario || null,
            tags: Array.isArray(prompts[index].tags) ? prompts[index].tags : [],
            reviewFocus: prompts[index].reviewFocus || null,
            forbiddenLeakTokens: Array.isArray(prompts[index].forbiddenLeakTokens)
              ? prompts[index].forbiddenLeakTokens
              : [],
          },
        });
        if (run.status === "success") success += 1;
        else partial += 1;
      } catch (error) {
        failed += 1;
        const code = error?.normalized?.code;
        if (SESSION_BLOCKING_CODES.has(code)) {
          console.error(`Batch stopped because the Doubao session is not healthy (${code}).`);
          break;
        }
      }

      if (index < prompts.length - 1 && delayMs > 0) {
        const jitter = Math.floor(Math.random() * Math.min(1_500, delayMs * 0.3 + 1));
        await session.page.waitForTimeout(delayMs + jitter);
      }
    }
  } finally {
    await session.close();
  }

  console.log(
    `批量执行结束：成功 ${success} 条，部分成功 ${partial} 条，失败 ${failed} 条`,
  );
}

async function runsCommand() {
  const config = loadConfig();
  const store = new RunStore(config);
  const runs = await store.listRuns();
  const rows = runs.slice(0, 30).map((run) => ({
    运行ID: run.id,
    项目: run.project,
    批次: run.samplingBatchId ?? "—",
    账号: run.accountKey ?? "—",
    状态: statusText(run.status),
    品牌已提及: run.brandMentioned ?? "—",
    引用数: (run.citations || []).length,
    页面标注: run.expectedCitationCount ?? "—",
    错误: run.errorCode ?? "—",
    提问: String(run.prompt || "").slice(0, 60),
  }));
  console.table(rows);
}

// ---------------------------------------------------------------------------
// Keyword sampling / visibility monitoring commands
// ---------------------------------------------------------------------------

async function projectInitCommand(args) {
  if (typeof args.file !== "string") throw new Error("--file is required");
  const pool = getPool();
  if (!pool) throw new Error("DATABASE_URL is not set; project setup requires PostgreSQL.");

  const config = await loadProjectConfig(args.file);
  console.log(`正在按 ${args.file} 配置项目「${config.project}」`);
  const summary = await applyProjectConfig(pool, config);

  if (summary.backfilledCitations) {
    console.log(
      `监控文章回填：已有 ${summary.backfilledCitations} 条历史引用匹配到监控文章`,
    );
  }
  console.log(`项目配置完成（数据库项目ID=${summary.projectId}）`);
}

async function poolListCommand(args) {
  const pool = getPool();
  if (!pool) throw new Error("DATABASE_URL is not set.");
  const project = typeof args.project === "string" ? args.project : null;

  const rows = (
    await pool.query(
      `SELECT p.category,
              count(*) AS prompts,
              count(*) FILTER (WHERE p.enabled) AS enabled,
              min(p.pool_version) AS pool_version
         FROM prompts p
         JOIN projects pr ON pr.id = p.project_id
        WHERE ($1::text IS NULL OR pr.name = $1)
        GROUP BY p.category
        ORDER BY prompts DESC, p.category`,
      [project],
    )
  ).rows;

  console.table(
    rows.map((row) => ({
      category: row.category ?? "(uncategorized)",
      prompts: Number(row.prompts),
      enabled: Number(row.enabled),
      pool_version: row.pool_version,
    })),
  );

  const [total] = (
    await pool.query(
      `SELECT count(*) AS total
         FROM prompts p
         JOIN projects pr ON pr.id = p.project_id
        WHERE ($1::text IS NULL OR pr.name = $1)`,
      [project],
    )
  ).rows;
  console.log(`pool size: ${total.total}`);
}

async function sampleCommand(args) {
  const pool = getPool();
  if (!pool) throw new Error("DATABASE_URL is not set.");

  const project = typeof args.project === "string" ? args.project : null;
  if (!project) throw new Error("--project is required");

  const size = Number(args.size ?? 0);
  if (!Number.isInteger(size) || size <= 0) throw new Error("--size must be a positive integer");

  const method = args.method === "random" ? "random" : "stratified";
  const seed = typeof args.seed === "string" ? args.seed : null;
  const repeats = Number(args.repeats ?? 1);
  if (!Number.isInteger(repeats) || repeats <= 0) throw new Error("--repeats must be >= 1");

  const accounts =
    typeof args.accounts === "string"
      ? parseAccountKeys(args.accounts)
      : parseAccountKeys(process.env.ONEGL_ACCOUNTS ?? "");
  if (!accounts.length) {
    throw new Error("--accounts account_01,account_02 is required (or set ONEGL_ACCOUNTS)");
  }

  await ensureAccounts(pool, { accountKeys: accounts });

  const name =
    typeof args.name === "string"
      ? args.name
      : `${project} ${new Date().toISOString().slice(0, 10)} sampling`;

  const result = await createSamplingBatch(pool, {
    projectName: project,
    name,
    size,
    method,
    seed,
    accounts,
    repeats,
  });

  console.log(
    `\n复现这次抽样：\n  npm run sample -- --project "${project}" --size ${result.sampleSize} ` +
      `--method ${method} --seed ${result.seed} --accounts ${accounts.join(",")} --repeats ${repeats}`,
  );
  console.log(`\n执行该批次：\n  npm run batch:run -- --batch ${result.batchId}`);
}

async function batchRunCommand(args) {
  const pool = getPool();
  if (!pool) throw new Error("DATABASE_URL is not set.");

  const batchId = Number(args.batch ?? 0);
  if (!Number.isInteger(batchId) || batchId <= 0) throw new Error("--batch <id> is required");

  const delayMs = Number(args["delay-ms"] ?? 6_000);
  const limit = args.limit ? Number(args.limit) : null;

  const batch = await loadBatch(pool, batchId);
  let assignments = await loadBatchAssignments(pool, batchId);
  if (Number.isInteger(limit) && limit > 0) assignments = assignments.slice(0, limit);
  if (!assignments.length) throw new Error(`Batch ${batchId} has no assignments`);

  const brandRules = await brandRulesFor(batch.project_name);
  if (!brandRules) {
    console.warn(
      `警告：项目「${batch.project_name}」未配置目标品牌，本次运行不会记录品牌提及判定。`,
    );
  }

  // Artifacts are project scoped, not account scoped, so the store keeps using the default config.
  const store = new RunStore(loadConfig());
  await markBatchStatus(pool, batchId, "running", { touchStart: true });

  const byAccount = new Map();
  for (const assignment of assignments) {
    const key = assignment.accountKey ?? "(unassigned)";
    if (!byAccount.has(key)) byAccount.set(key, []);
    byAccount.get(key).push(assignment);
  }

  let success = 0;
  let partial = 0;
  let failed = 0;

  try {
    for (const [accountKey, accountAssignments] of byAccount) {
      const config = loadConfig({ accountKey });
      const session = await launchBrowserSession(config);
      console.log(`\n账号 ${accountKey}：共 ${accountAssignments.length} 条提问`);
      try {
        await openDoubao(session.page, config);
        for (const assignment of accountAssignments) {
          try {
            const saved = await executeOne({
              page: session.page,
              store,
              config,
              prompt: assignment.prompt,
              project: batch.project_name,
              context: { accountKey, samplingBatchId: batchId, brandRules },
              validation: {
                caseId: `batch_${batchId}_${assignment.selectionIndex}`,
                targetScenario: assignment.category,
                tags: [assignment.category].filter(Boolean),
              },
            });
            if (saved.status === "success") success += 1;
            else partial += 1;
          } catch (error) {
            failed += 1;
            const code = error?.normalized?.code;
            if (SESSION_BLOCKING_CODES.has(code)) {
              console.error(
                `账号 ${accountKey} 的会话不可用（${code}），已停止该账号的后续提问。`,
              );
              break;
            }
          }
          await session.page.waitForTimeout(delayMs);
        }
      } finally {
        await session.close();
      }
    }

    await markBatchStatus(pool, batchId, success > 0 ? "completed" : "failed", {
      touchEnd: true,
    });
  } catch (error) {
    await markBatchStatus(pool, batchId, "failed", { touchEnd: true }).catch(() => undefined);
    throw error;
  }

  console.log(
    `\n批次 ${batchId} 执行结束：成功 ${success} 条，部分成功 ${partial} 条，失败 ${failed} 条`,
  );
  printBatchReport(await buildBatchReport(pool, batchId));
}

async function reportCommand(args) {
  const pool = getPool();
  if (!pool) throw new Error("DATABASE_URL is not set.");
  const batchId = Number(args.batch ?? 0);
  if (!Number.isInteger(batchId) || batchId <= 0) throw new Error("--batch <id> is required");

  const report = await buildBatchReport(pool, batchId);
  printBatchReport(report);
  if (args.json) console.log(JSON.stringify(report, null, 2));
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (!command || command === "help" || args.help) {
    printHelp();
    return;
  }

  try {
    if (command === "auth") await authCommand(args);
    else if (command === "run") await runCommand(args);
    else if (command === "batch") await batchCommand(args);
    else if (command === "runs") await runsCommand();
    else if (command === "project-init") await projectInitCommand(args);
    else if (command === "pool-list") await poolListCommand(args);
    else if (command === "sample") await sampleCommand(args);
    else if (command === "batch-run") await batchRunCommand(args);
    else if (command === "report") await reportCommand(args);
    else throw new Error(`Unknown command: ${command}`);
  } finally {
    // A database failure must be visible to whatever invoked the collector, while the
    // Run itself and its debug artifacts survive.
    await closePool();
    if (databaseFailures > 0) {
      console.error(
        `有 ${databaseFailures} 条运行写入数据库失败，本地调试产物已保留。`,
      );
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
