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
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
// 出口必须能自证，否则「匿名面被风控」和「走了哪个 IP」永远对不上。
console.log(`[verify] proxy=${JSON.stringify(session.proxy)}`);
// 身份也必须自证。被拦时第一个问题永远是「这是不是同一个指纹」——
// 光看日志答不出来，只能翻状态文件；而状态文件不在跑的人手边。
console.log(`[verify] identity=${JSON.stringify(session.fingerprintRotation?.identity ?? null)}`);
console.log(`[verify] preset=${JSON.stringify(session.fingerprintRotation?.preset ?? null)}`);

try {
  // 光有配置声明不等于真的走了代理。进豆包之前先问一次「我是谁」，
  // 把「浏览器实际出口」变成观测事实 —— 排查风控时这两者的区别就是全部。
  const egressIp = await page
    .goto("http://members.3322.org/dyndns/getip", { waitUntil: "domcontentloaded", timeout: 30_000 })
    .then(() => page.evaluate(() => (document.body?.innerText || "").trim()))
    .catch((error) => `unavailable: ${String(error.message).split("\n")[0]}`);
  console.log(`[verify] egress_ip=${egressIp}`);

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

  // 成功也要留档。2026-10-16 的教训：那天三次成功只有终端日志，
  // 事后被质疑「那三次真是豆包吗」时，翻不出任何可复查的凭据 ——
  // 而失败反而有截图。留档必须对称，否则证据只覆盖坏消息。
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const artifactDir = path.resolve(".runtime/anon-artifacts", stamp);
  try {
    mkdirSync(artifactDir, { recursive: true });
    await page.screenshot({ path: path.join(artifactDir, "page.png") }).catch(() => undefined);
    writeFileSync(path.join(artifactDir, "page.html"), await page.content().catch(() => ""), "utf8");
    writeFileSync(
      path.join(artifactDir, "summary.json"),
      `${JSON.stringify(
        {
          outcome: "success",
          url: result.currentUrl ?? page.url(),
          proxy: session.proxy,
          identity: session.fingerprintRotation?.identity ?? null,
          preset: session.fingerprintRotation?.preset ?? null,
          answerChars: (result.answer ?? "").length,
          citations: result.citations?.length ?? 0,
          citationState: result.citationState ?? null,
          submissionMethod: result.submissionMethod ?? null,
          answer: result.answer ?? "",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    console.log(`[verify] 成功现场: ${artifactDir}`);
  } catch (dumpError) {
    console.log("[verify] 成功现场落盘失败:", dumpError?.message);
  }
} catch (error) {
  console.log("\n=== 失败 ===");
  console.log("name    :", error?.name);
  console.log("code    :", error?.code ?? "(无)");
  console.log("message :", error?.message);
  console.log("details :", JSON.stringify(error?.details ?? {}).slice(0, 400));
  // 失败现场必须落盘：截图 + HTML + 可见弹窗文本。
  // 「输入框不存在」这种结论只说明页面没到可用状态，说明不了**为什么** ——
  // 而过去四次诊断全靠事后翻截图，代价是半小时起步。
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const artifactDir = path.resolve(".runtime/anon-artifacts", stamp);
  try {
    mkdirSync(artifactDir, { recursive: true });
    await page.screenshot({ path: path.join(artifactDir, "page.png") }).catch(() => undefined);
    writeFileSync(path.join(artifactDir, "page.html"), await page.content().catch(() => ""), "utf8");
    const visible = await page
      .evaluate(() => {
        const norm = (v) => String(v || "").replace(/\s+/g, " ").trim();
        const nodes = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"],div[class*="dialog" i],div[class*="popup" i],div[class*="modal" i],div[class*="mask" i]')];
        return nodes
          .map((el) => {
            const rect = el.getBoundingClientRect();
            return {
              cls: String(el.className || "").slice(0, 60),
              size: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
              text: norm(el.innerText).slice(0, 160),
            };
          })
          .filter((item) => item.text && !item.size.startsWith("0x"))
          .slice(0, 8);
      })
      .catch(() => []);
    writeFileSync(
      path.join(artifactDir, "summary.json"),
      `${JSON.stringify({ url: page.url(), proxy: session.proxy, identity: session.fingerprintRotation?.identity, visible }, null, 2)}\n`,
      "utf8",
    );
    console.log(`[verify] 失败现场: ${artifactDir}`);
    console.log(`[verify] 可见弹窗: ${JSON.stringify(visible)}`);
  } catch (dumpError) {
    console.log("[verify] 现场落盘失败:", dumpError?.message);
  }
  // 失败时浏览器会在 finally 里立刻关掉，人工看不到现场。有头模式下把窗口留住，
  // 让「为什么失败」能被眼睛验证一次，而不是只能靠日志反推。
  const holdMs = Number(process.env.ONEGL_VERIFY_HOLD_MS ?? 0);
  if (Number.isFinite(holdMs) && holdMs > 0) {
    console.log(`[verify] 保持窗口打开 ${holdMs}ms 供人工观察（ONEGL_VERIFY_HOLD_MS）`);
    await delay(holdMs);
  }
} finally {
  await session.close().catch(() => undefined);
}
