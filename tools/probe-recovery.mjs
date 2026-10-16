#!/usr/bin/env node
/**
 * 恢复曲线探针：被风控之后，这个出口到底多久能用回来。
 *
 *   node tools/probe-recovery.mjs --interval-min 15 --max-minutes 150
 *
 * 每个周期只发**1 条对话**（额度宝贵，探测不该比实验本身还贵），记录：
 *   时刻 → 结果 → 失败形态 → URL 形态 → 身份/出口
 *
 * 判定：
 *   · **连续 2 次成功**才算恢复 —— 单次成功可能是漏网，今天已经见过
 *     「同一配置 3 次成功后接 2 次失败」的抖动
 *   · 恢复时打印 RECOVERED，并给出可以接着跑的那条命令（N=5 对照）
 *
 * 依赖环境变量（与实验一致）：
 *   ONEGL_PROXY_POOL_FILE   出口（决定测的是哪个 IP）
 *   ONEGL_DOUBAO_ANONYMOUS=1
 *   ONEGL_DOUBAO_FIRST_TOKEN_MS  建议 45000：让静默软墙 45 秒暴露，而不是白等 180 秒
 */
import "dotenv/config";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { launchBrowserSession } from "../src/browser.js";
import { loadConfig } from "../src/config.js";
import { executeDoubaoPrompt } from "../src/doubao.js";

const PROMPT = "绍兴越城区推拿按摩哪家手法好？";
const RECOVERED_STREAK = 2;

function parseArgs(argv) {
  const options = { intervalMin: 15, maxMinutes: 150, outDir: "local/stress" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--interval-min") options.intervalMin = Number(argv[++index]);
    else if (arg === "--max-minutes") options.maxMinutes = Number(argv[++index]);
    else if (arg === "--out-dir") options.outDir = argv[++index];
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

/** 失败形态分类：三类的处置完全不同，混在一起就没法算冷却。 */
function classify(record) {
  const url = record.url ?? "";
  if (record.outcome === "success") return "recovered-attempt";
  if (record.code === "RATE_LIMITED") return "throttled";         // 窗口级：冷却即可
  if (/\/chat\/local_/.test(url)) return "soft-wall";             // 静默丢答案：该组合已废
  if (record.code === "PAGE_CHANGED") return "hard-wall";         // 区域封禁等
  return "unknown";
}

const options = parseArgs(process.argv.slice(2));
const runId = new Date().toISOString().replace(/[:.]/g, "-");
mkdirSync(options.outDir, { recursive: true });
const jsonlPath = path.join(options.outDir, `recovery-${runId}.jsonl`);
const startedAt = Date.now();

const cycles = [];
let successStreak = 0;
let recoveredAt = null;

for (let cycle = 1; ; cycle += 1) {
  const elapsedMin = Math.round((Date.now() - startedAt) / 60_000);
  const record = { cycle, at: new Date().toISOString(), elapsedMin, outcome: null, code: null, url: null };
  let session = null;
  try {
    const config = loadConfig({ provider: "doubao" });
    session = await launchBrowserSession(config, { ignoreStoredAuth: true });
    record.proxy = session.proxy?.exit_id ?? null;
    record.identity = session.fingerprintRotation?.identity?.digest ?? null;
    await session.page.goto(config.doubaoUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const result = await executeDoubaoPrompt(session.page, PROMPT, config);
    record.outcome = "success";
    record.answerChars = (result.answer ?? "").length;
    record.citations = result.citations?.length ?? 0;
    record.url = result.currentUrl ?? null;
  } catch (error) {
    record.outcome = "failure";
    record.code = error?.code ?? error?.name ?? "UNKNOWN";
    record.message = String(error?.message ?? error).split("\n")[0].slice(0, 140);
    record.url = session?.page?.url?.() ?? null;
  } finally {
    await session?.close().catch(() => undefined);
  }
  record.tier = classify(record);
  record.durationMs = Date.now() - startedAt;

  cycles.push(record);
  appendFileSync(jsonlPath, `${JSON.stringify(record)}\n`, "utf8");
  console.log(
    `[+${String(elapsedMin).padStart(3)}min] #${cycle} ${record.outcome === "success" ? "✅" : "❌"} ` +
      `${record.tier}${record.code ? `(${record.code})` : ""} ${record.answerChars ?? ""}` +
      `${record.url ? ` ${record.url.replace("https://www.doubao.com/chat/", ".../")}` : ""}`,
  );

  if (record.outcome === "success") {
    successStreak += 1;
    if (successStreak >= RECOVERED_STREAK && !recoveredAt) {
      recoveredAt = record.at;
      console.log(`\n★ RECOVERED：连续 ${RECOVERED_STREAK} 次成功（${record.at}，距起点 ${elapsedMin} 分钟）`);
      console.log("  可以接着跑 N=5 对照：");
      console.log("  node tools/stress-doubao-anonymous.mjs --rounds 1 --talks-per-session 5 --stop-after 2");
      break;
    }
  } else {
    successStreak = 0;
  }

  if (Date.now() - startedAt >= options.maxMinutes * 60_000) {
    console.log(`\n达到 --max-minutes ${options.maxMinutes} 仍未恢复，停止探测`);
    break;
  }
  await delay(options.intervalMin * 60_000);
}

const summary = {
  runId,
  cycles: cycles.length,
  recoveredAt,
  elapsedMin: Math.round((Date.now() - startedAt) / 60_000),
  tiers: cycles.reduce((acc, item) => ({ ...acc, [item.tier]: (acc[item.tier] ?? 0) + 1 }), {}),
  timeline: cycles.map((item) => `${item.elapsedMin}min:${item.tier}`),
};
writeFileSync(path.join(options.outDir, `recovery-${runId}.summary.json`), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(`\n结果: ${jsonlPath}`);
console.log(`摘要: ${path.join(options.outDir, `recovery-${runId}.summary.json`)}`);
