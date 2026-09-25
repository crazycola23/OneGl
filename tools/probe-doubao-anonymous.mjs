/**
 * 豆包匿名面可行性探测。
 *
 * 前提问题只有一个：**匿名访客能不能真的把问题问出去**。
 * 「首页能打开、输入框可见」不算通过 —— 得看提交之后平台给不给答案，或者是否在提交时
 * 才挂出登录要求（那时提问已提交，豆包的失败是 no-retry，等于白烧一条）。
 *
 * 这个脚本只做观测，不改任何线上状态：
 *   - 用匿名 context（空 storage state）打开 www.doubao.com
 *   - 记录 inspectSession 的判定（匿名开关开与关各判一次，看差异）
 *   - 提交一个真实问题，把提交后的每一轮状态与可见文案记下来
 *   - 结论只看一件事：有没有拿到非空的答案文本
 *
 *   node tools/probe-doubao-anonymous.mjs
 */
import { setTimeout as delay } from "node:timers/promises";

import { launchBrowserSession } from "../src/browser.js";
import { loadConfig } from "../src/config.js";
import { inspectSession } from "../src/doubao.js";

const config = loadConfig({
  provider: "doubao",
  // 不读任何已存登录态：这才是「匿名」。
  storageState: null,
  headless: true,
});

const PROMPT = "绍兴越城区推拿按摩哪家手法好？";

function log(step, detail = "") {
  console.log(`[probe] ${step}${detail ? ` :: ${detail}` : ""}`);
}

const session = await launchBrowserSession(config);
const { page } = session;
log("browser-launched", `hasStoredAuth=${session.hasStoredAuth}`);

/** 等 composer 真正挂载。固定 sleep 不够：冷启动时 readyState 到 interactive 时它还没出现。 */
async function waitForComposer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  const selector = 'textarea, [contenteditable="true"], [role="textbox"]';
  while (Date.now() < deadline) {
    const count = await page.locator(selector).count().catch(() => 0);
    if (count > 0) {
      const visible = await page
        .locator(selector)
        .first()
        .isVisible()
        .catch(() => false);
      if (visible) return true;
    }
    await delay(1_000);
  }
  return false;
}

try {
  await page.goto(config.doubaoUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  log("navigated", page.url());

  const composerReady = await waitForComposer();
  log("composer-ready", String(composerReady));

  // 1) 页面自述：登录态、输入框、登录按钮、可见对话文案
  const diagnosis = await page.evaluate(() => {
    const seen = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const textboxes = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')].filter(seen);
    const loginButtons = [...document.querySelectorAll("button")].filter(
      (b) => seen(b) && (b.innerText || "").trim() === "登录",
    );
    const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], .semi-modal, [role="alert"]')]
      .filter(seen)
      .map((el) => (el.innerText || "").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const routerLogin = window._ROUTER_DATA?.loaderData?.chat_layout?.userSetting?.data?.is_login;
    return {
      routerLogin: routerLogin ?? null,
      textboxCount: textboxes.length,
      textboxPlaceholder: textboxes[0]?.getAttribute("placeholder") ?? textboxes[0]?.getAttribute("data-placeholder") ?? null,
      loginButtonCount: loginButtons.length,
      dialogs: dialogs.slice(0, 5),
      bodyHead: (document.body.innerText || "").replace(/\s+/g, " ").trim().slice(0, 300),
    };
  });
  log("page-diagnosis", JSON.stringify(diagnosis, null, 2));

  // 2) 两种判定的差异：这就是改造前后会走的分支
  const strict = await inspectSession(page, { anonymous: false });
  const anon = await inspectSession(page, { anonymous: true });
  log("inspectSession(anonymous=false)", strict.state);
  log("inspectSession(anonymous=true)", anon.state);

  // 3) 真正的判定：提交一个问题，看平台给不给答案
  //
  // 提交是否成功要看 url 变不变（豆包会给新会话分配 /chat/<id>），而不是看正文长度 ——
  // 首页本身就有一大堆推荐语，长度增长完全可能来自它。第一次探测时 url 变了、答案也出来了；
  // 第二次 url 没变、正文却长了 326 字，那 326 字其实是首页的推广文案，差点被当成成功。
  const urlBefore = page.url();
  const composer = page.locator('textarea, [contenteditable="true"], [role="textbox"]').first();
  await composer.click({ timeout: 15_000 }).catch(() => undefined);
  await composer.fill(PROMPT).catch(async () => {
    await composer.pressSequentially(PROMPT, { delay: 25 });
  });
  const typed = await page
    .locator('textarea, [contenteditable="true"], [role="textbox"]')
    .first()
    .inputValue()
    .catch(() => "");
  log("prompt-typed", `len=${typed.length} value=${JSON.stringify(typed.slice(0, 40))}`);
  await delay(1_500);

  const sendSelectors = [
    'button[type="submit"]',
    'button:has-text("发送")',
    '[data-testid*="send"]',
    'button[aria-label*="发送"]',
  ];
  let sentBy = "enter";
  for (const selector of sendSelectors) {
    const candidate = page.locator(selector).first();
    if (await candidate.isVisible().catch(() => false)) {
      await candidate.click({ timeout: 5_000 }).catch(() => undefined);
      sentBy = selector;
      break;
    }
  }
  if (sentBy === "enter") await composer.press("Enter").catch(() => undefined);
  log("prompt-submitted", sentBy);

  // 提交是否被接受：等 url 变化（豆包把会话挂到 /chat/<id>）。这是唯一不会和首页
  // 推荐文案混淆的信号。
  const urlDeadline = Date.now() + 20_000;
  let urlChanged = false;
  while (Date.now() < urlDeadline) {
    if (page.url() !== urlBefore) {
      urlChanged = true;
      break;
    }
    await delay(1_000);
  }
  log("submit-accepted", `urlChanged=${urlChanged} url=${page.url()}`);
  if (!urlChanged) {
    log("VERDICT-SUBMIT-FAILED", "提交后 url 未变化 —— 这次提问没有真正发出去，结论不可用");
  }

  // 4) 逐轮观测：是否有答案文本增长、是否出现登录墙
  let lastLength = 0;
  for (let round = 1; round <= 12; round += 1) {
    await delay(5_000);
    const snapshot = await page.evaluate(() => {
      const text = (document.body.innerText || "").replace(/\s+/g, " ").trim();
      return {
        url: location.href,
        textLength: text.length,
        wall: /扫码登录|请登录后使用|登录后继续|登录以解锁|立即登录|手机号登录/.test(text),
        answerish: text.length,
      };
    });
    const grew = snapshot.textLength - lastLength;
    log(
      `round-${round}`,
      `textLen=${snapshot.textLength} (+${grew}) wall=${snapshot.wall} url=${snapshot.url}`,
    );
    lastLength = snapshot.textLength;

    // 出现登录墙就立刻停：这正是要判定的坏结局
    if (snapshot.wall) {
      log("VERDICT-WALL", "提交后出现登录要求 —— 匿名提问不被接受");
      break;
    }
    if (round >= 3 && grew === 0 && snapshot.textLength > PROMPT.length + 50) {
      log("VERDICT-OK", "答案文本稳定增长后停住，未出现登录要求");
      break;
    }
  }

  const finalText = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").trim());
  console.log("\n=== 最终页面正文（尾部 600 字，看有没有真答案） ===");
  console.log(finalText.slice(-600));
  console.log("\n提示词长度 =", PROMPT.length, " 正文长度 =", finalText.length);
} finally {
  await session.close().catch(() => undefined);
}
