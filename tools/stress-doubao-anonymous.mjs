#!/usr/bin/env node
/**
 * 匿名面风控压测台：连续跑 N 次匿名提问，逐次记录结果，回答两个问题 ——
 *  1) 第几次开始被限制（阈值曲线）
 *  2) 被限制后是否/多久恢复（由后续的冷却复测填表，本工具只负责跑与记录）
 *
 *   node tools/stress-doubao-anonymous.mjs --rounds 8 --gap-ms 45000 [--stop-after 2]
 *   node tools/stress-doubao-anonymous.mjs --rounds 2 --talks-per-session 5
 *
 * 术语：**会话 = 浏览器窗口**，**对话 = 窗口里的一次提问**。
 *
 * `--talks-per-session` 就是用户模型里的 N：
 *   N=1 → 现在生产的行为（每个窗口一句，问完就换身份）
 *   N=5 → 「1 窗口 : 1 IP : 1 指纹 : 5 条对话」，像真人连续追问
 * 这个对照决定该买「少量长效 IP」还是「大量短效 IP」，所以必须能跑。
 *
 * 每个会话都是独立冷启动 + 独立身份（沿用自动轮换），出口由 ONEGL_PROXY_POOL_FILE 决定。
 * 结果逐条落盘到 JSONL —— 中途崩溃也不丢已有样本。
 */
import "dotenv/config";
import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { launchBrowserSession } from "../src/browser.js";
import { loadConfig } from "../src/config.js";
import { executeDoubaoPrompt } from "../src/doubao.js";

const PROMPTS = [
  "绍兴越城区推拿按摩哪家手法好？",
  "绍兴越城区哪家中医推拿治颈椎病比较专业？",
  "绍兴越城区有没有适合上班族的肩颈调理店？",
  "绍兴越城区推拿一般多少钱一次？",
  "绍兴越城区推拿店的营业时间一般到几点？",
  "绍兴越城区哪家推拿店支持医保？",
  "绍兴越城区口碑好的正骨推拿店有哪些？",
  "绍兴越城区周末推拿需要提前预约吗？",
];

/** 硬墙：这一组（IP+身份）已经不可用，继续在这个窗口里问没有意义。 */
const HARD_WALL_CODES = new Set([
  "DOUBAO_VERIFICATION_REQUIRED",
  "DOUBAO_ACCESS_RESTRICTED",
  "DOUBAO_LOGIN_REQUIRED",
  "PAGE_CHANGED",
]);

function parseArgs(argv) {
  const options = { rounds: 8, gapMs: 45_000, stopAfter: 2, outDir: "local/stress", talksPerSession: 1 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--rounds") options.rounds = Number(argv[++index]);
    else if (arg === "--gap-ms") options.gapMs = Number(argv[++index]);
    else if (arg === "--stop-after") options.stopAfter = Number(argv[++index]);
    else if (arg === "--out-dir") options.outDir = argv[++index];
    else if (arg === "--talks-per-session") options.talksPerSession = Number(argv[++index]);
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const runId = new Date().toISOString().replace(/[:.]/g, "-");
mkdirSync(options.outDir, { recursive: true });
const jsonlPath = path.join(options.outDir, `${runId}.jsonl`);

const attempts = [];
let consecutiveFailures = 0;

for (let round = 1; round <= options.rounds; round += 1) {
  const sessionStartedAt = new Date().toISOString();
  const sessionStarted = Date.now();
  let session = null;

  try {
    const config = loadConfig({ provider: "doubao" });
    session = await launchBrowserSession(config, { ignoreStoredAuth: true });
    const baseRecord = {
      round,
      sessionStartedAt,
      proxy: session.proxy?.exit_id ?? null,
      identity: session.fingerprintRotation?.identity?.digest ?? null,
      platform: session.fingerprintRotation?.identity?.platform ?? null,
    };
    await session.page.goto(config.doubaoUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

    for (let talk = 1; talk <= options.talksPerSession; talk += 1) {
      const talkStarted = Date.now();
      const record = { ...baseRecord, talk, talksPerSession: options.talksPerSession };
      try {
        const result = await executeDoubaoPrompt(session.page, PROMPTS[(round * 3 + talk) % PROMPTS.length], config);
        record.outcome = "success";
        record.answerChars = (result.answer ?? "").length;
        record.citations = result.citations?.length ?? 0;
        record.citationState = result.citationState ?? null;
        record.submission = result.submissionMethod ?? null;
        record.url = result.currentUrl ?? null;
      } catch (error) {
        record.outcome = "failure";
        record.code = error?.code ?? error?.name ?? "UNKNOWN";
        record.message = String(error?.message ?? error).split("\n")[0].slice(0, 160);
        record.detailsStage = error?.details?.stage ?? null;
        // 失败也要记 URL。软墙的判据就藏在 URL 形态里（`/chat/local_<id>` vs 纯数字 id），
        // 而它只出现在 stdout 日志里时，事后没法统计 —— 2026-10-16 就是靠人眼从两行日志抠出来的。
        record.url = session?.page?.url?.() ?? null;
      }
      record.durationMs = Date.now() - talkStarted;
      attempts.push(record);
      appendFileSync(jsonlPath, `${JSON.stringify(record)}\n`, "utf8");
      console.log(
        `#${round}.${talk} ${record.outcome === "success" ? "✅" : "❌"} ` +
          `${record.outcome === "success" ? `${record.answerChars}字/${record.citations}引用` : record.code} ` +
          `| ${record.platform ?? "-"} ${record.identity ?? "-"} | ${Math.round(record.durationMs / 1000)}s`,
      );

      if (record.outcome === "success") {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures += 1;
        if (HARD_WALL_CODES.has(record.code)) {
          console.log(`  命中硬墙 ${record.code}，本会话停止；该组合（IP+身份）应废弃`);
          break;
        }
      }
      if (consecutiveFailures >= options.stopAfter) break;
    }
  } catch (error) {
    const record = {
      round,
      talk: 1,
      breakdown: "session-setup",
      sessionStartedAt,
      outcome: "failure",
      code: error?.code ?? error?.name ?? "UNKNOWN",
      message: String(error?.message ?? error).split("\n")[0].slice(0, 160),
      durationMs: Date.now() - sessionStarted,
    };
    attempts.push(record);
    appendFileSync(jsonlPath, `${JSON.stringify(record)}\n`, "utf8");
    console.log(`#${round}.? ❌ ${record.code}（会话建立失败）`);
    consecutiveFailures += 1;
  } finally {
    await session?.close().catch(() => undefined);
  }

  if (consecutiveFailures >= options.stopAfter) {
    console.log(`连续 ${consecutiveFailures} 次失败，停止本轮压测（阈值已触达）`);
    break;
  }
  if (round < options.rounds) await delay(options.gapMs);
}

const success = attempts.filter((item) => item.outcome === "success").length;
const firstFailure = attempts.find((item) => item.outcome === "failure");
const summary = {
  runId,
  sessions: options.rounds,
  talksPerSession: options.talksPerSession,
  talks: attempts.length,
  success,
  failure: attempts.length - success,
  firstFailureAt: firstFailure ? `#${firstFailure.round}.${firstFailure.talk ?? "?"}` : null,
  firstFailureCode: firstFailure?.code ?? null,
  codes: attempts.filter((item) => item.code).map((item) => `#${item.round}.${item.talk ?? "?"}:${item.code}`),
  gapMs: options.gapMs,
  finishedAt: new Date().toISOString(),
};
writeFileSync(path.join(options.outDir, `${runId}.summary.json`), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

console.log(
  `\n成功 ${success}/${attempts.length} 条对话（${options.rounds} 个会话 × ${options.talksPerSession} 条）` +
    `，首次失败在 ${summary.firstFailureAt ?? "—"}`,
);
console.log(`结果: ${jsonlPath}`);
console.log(`摘要: ${path.join(options.outDir, `${runId}.summary.json`)}`);
