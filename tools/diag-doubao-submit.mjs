/**
 * 豆包匿名提交失败的归因探测。
 *
 * 前三次探测里只有 1 次真的把问题发出去（url 变了、拿到 826 字答案），另外两次 url 没变。
 * 但诊断输入框内容的那一行被日志过滤掉了，所以「是填不进去、还是点不动发送」一直没分清。
 * 这个脚本只回答那一个问题，把每一步的原始状态都打出来。
 */
import { setTimeout as delay } from "node:timers/promises";

import { launchBrowserSession } from "../src/browser.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig({ provider: "doubao", storageState: null, headless: true });
const PROMPT = "绍兴越城区推拿按摩哪家手法好？";

const session = await launchBrowserSession(config);
const { page } = session;
const log = (step, detail = "") => console.log(`[diag] ${step}${detail ? ` :: ${detail}` : ""}`);

try {
  await page.goto(config.doubaoUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

  // 等 composer
  const selector = 'textarea, [contenteditable="true"], [role="textbox"]';
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && (await page.locator(selector).count().catch(() => 0)) === 0) {
    await delay(1_000);
  }

  const composerInfo = await page.evaluate((sel) => {
    const seen = (el) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0;
    };
    return [...document.querySelectorAll(sel)].map((el, i) => ({
      index: i,
      tag: el.tagName.toLowerCase(),
      visible: seen(el),
      editable: el.getAttribute("contenteditable"),
      cls: (el.className || "").toString().slice(0, 60),
    }));
  }, selector);
  log("composer-candidates", JSON.stringify(composerInfo));

  // 逐个尝试填写，打印每一步的读回值
  const count = await page.locator(selector).count();
  for (let i = 0; i < Math.min(count, 4); i += 1) {
    const candidate = page.locator(selector).nth(i);
    const visible = await candidate.isVisible().catch(() => false);
    if (!visible) continue;

    await candidate.click({ timeout: 8_000 }).catch(() => undefined);
    await candidate.fill(PROMPT).catch((error) => log(`fill-threw[${i}]`, String(error).slice(0, 80)));
    await delay(800);

    // page.evaluate 只接受一个参数，多传会直接抛错；要传多个值就包成对象。
    const readBack = await page.evaluate(({ sel, index }) => {
      const el = document.querySelectorAll(sel)[index];
      if (!el) return null;
      return {
        value: el.value ?? null,
        innerText: (el.innerText || "").slice(0, 60),
        textContent: (el.textContent || "").slice(0, 60),
      };
    }, { sel: selector, index: i });
    log(`fill-readback[${i}]`, JSON.stringify(readBack));

    if (readBack && (readBack.value === PROMPT || readBack.innerText.includes("推拿"))) {
      log(`fill-ok[${i}]`, "内容确实进去了");
      break;
    }
  }

  // 提交前：把所有可见按钮列出来（找发送键）
  const buttons = await page.evaluate(() => {
    const seen = (el) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.display !== "none" && r.width > 0 && r.height > 0;
    };
    return [...document.querySelectorAll("button")]
      .filter(seen)
      .map((b) => ({
        text: (b.innerText || "").trim().slice(0, 12),
        testid: b.getAttribute("data-testid"),
        aria: b.getAttribute("aria-label"),
        disabled: b.disabled,
      }))
      .filter((b) => b.text || b.testid || b.aria);
  });
  log("visible-buttons", JSON.stringify(buttons));

  const urlBefore = page.url();
  const sendCandidates = [
    '[data-testid*="send"]',
    'button[type="submit"]',
    'button[aria-label*="发送"]',
    'button:has-text("发送")',
  ];
  for (const sel of sendCandidates) {
    const btn = page.locator(sel).first();
    const visible = await btn.isVisible().catch(() => false);
    const disabled = visible ? await btn.isDisabled().catch(() => null) : null;
    log(`send-candidate ${sel}`, `visible=${visible} disabled=${disabled}`);
    if (visible && disabled === false) {
      await btn.click({ timeout: 5_000 }).catch((e) => log("click-threw", String(e).slice(0, 80)));
      log("clicked", sel);
      break;
    }
  }

  // 提交后观察
  for (let round = 1; round <= 8; round += 1) {
    await delay(4_000);
    const state = await page.evaluate(() => ({
      url: location.href,
      len: (document.body.innerText || "").replace(/\s+/g, " ").trim().length,
    }));
    log(`round-${round}`, `url=${state.url} len=${state.len}`);
    if (state.url !== urlBefore) {
      log("SUBMIT-ACCEPTED", `url 变化 -> ${state.url}`);
      break;
    }
  }
  if (page.url() === urlBefore) log("SUBMIT-REJECTED", `url 始终未变：${urlBefore}`);

  const tail = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").trim().slice(-300));
  console.log("\n=== 页面尾部 ===");
  console.log(tail);
} finally {
  await session.close().catch(() => undefined);
}
