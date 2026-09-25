/**
 * 豆包匿名面的端到端验证：跑 OneGl 自己的采集流程，而不是探测脚本自造的简化点击。
 *
 * 为什么换掉之前的探测方式：`tools/probe-doubao-anonymous.mjs` 用
 * `[data-testid*="send"]` 通配 + `.first()` 点发送键，会超时（该通配匹配到多个元素）。
 * OneGl 正式的 `tryClickSend` 用的是精确选择器 `button[data-testid="chat_input_send_button"]`，
 * 而且从后往前遍历、带 isEnabled 回退，还有 waitForSubmissionConfirmation 兜底。
 * 平台允许不允许匿名提问，必须用正式流程判定，否则量到的是探测脚本自己的缺陷。
 *
 *   ONEGL_DOUBAO_ANONYMOUS=1 node tools/verify-doubao-anonymous.mjs
 */
import { launchBrowserSession } from "../src/browser.js";
import { loadConfig } from "../src/config.js";
import { doubaoAnonymousEnabled, executeDoubaoPrompt } from "../src/doubao.js";

const PROMPT = "绍兴越城区推拿按摩哪家手法好？";
const config = loadConfig({ provider: "doubao", storageState: null, headless: true });

console.log(`[verify] ONEGL_DOUBAO_ANONYMOUS=${process.env.ONEGL_DOUBAO_ANONYMOUS ?? "(未设置)"}`);
console.log(`[verify] doubaoAnonymousEnabled()=${doubaoAnonymousEnabled()}`);

const session = await launchBrowserSession(config);
const { page } = session;
console.log(`[verify] browser ready, hasStoredAuth=${session.hasStoredAuth}`);

try {
  await page.goto(config.doubaoUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

  const started = Date.now();
  const result = await executeDoubaoPrompt(page, PROMPT, config);
  const durationMs = Date.now() - started;

  console.log("\n=== 结果 ===");
  console.log("status          : success");
  console.log("duration_ms     :", durationMs);
  console.log("answer_chars    :", (result.answer ?? "").length);
  console.log("submission      :", result.submissionMethod);
  console.log("reset_confirmed :", result.conversationResetConfirmed);
  console.log("current_url     :", result.currentUrl);
  console.log("citations       :", result.citations?.length ?? 0, "state=", result.citationState);
  console.log("\n--- 答案开头 ---");
  console.log((result.answer ?? "").slice(0, 300));
} catch (error) {
  console.log("\n=== 失败 ===");
  console.log("name    :", error?.name);
  console.log("code    :", error?.code ?? "(无)");
  console.log("message :", error?.message);
  console.log("details :", JSON.stringify(error?.details ?? {}).slice(0, 400));
} finally {
  await session.close().catch(() => undefined);
}
