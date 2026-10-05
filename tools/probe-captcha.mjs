import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { extractVisibleCitations } from "../src/doubao.js";

/**
 * 对照实验：验证「换指纹能不能绕过豆包的人机验证」。
 *
 * 做法：读 worker 保存的 page.html 快照，离线检查验证容器是否存在。
 * 这是纯读操作，不触碰线上浏览器。
 */
const file = process.argv[2];
if (!file) {
  console.error("usage: node tools/probe-captcha.mjs <page.html>");
  process.exit(1);
}
const html = readFileSync(file, "utf8");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.route("**", (r) => r.abort().catch(() => undefined));
await page.setContent(html, { waitUntil: "domcontentloaded" });

const out = await page.evaluate(() => {
  const norm = (v) => String(v || "").replace(/\s+/g, " ").trim();
  const visible = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
  };
  const cap = document.querySelector("#captcha_container");
  const capStyle = cap ? getComputedStyle(cap) : null;
  const iframe = [...document.querySelectorAll("iframe")]
    .map((f) => ({ src: (f.src || "").slice(0, 120), visible: visible(f) }))
    .filter((f) => /verifycenter|captcha/i.test(f.src));
  const answers = [...document.querySelectorAll(
    '.md-box-root, [class*="md-box-root"], [data-testid="message_text_content"], ' +
    '[data-testid="message_content"], .flow-markdown-body',
  )].filter(visible);
  const sendFailed = document.querySelectorAll('[data-testid="message_box_failed_icon"]').length;
  return {
    captchaContainer: !!cap,
    captchaDisplay: capStyle?.display ?? null,
    captchaVisible: cap ? visible(cap) : false,
    verifyIframes: iframe,
    visibleAnswers: answers.length,
    answerHeads: answers.map((a) => norm(a.innerText).slice(0, 26)),
    sendFailedIcons: sendFailed,
    block10025: document.querySelectorAll('[data-plugin-identifier*="block_type:10025"]').length,
    externalLinks: [...document.querySelectorAll("a[href]")].filter((a) =>
      /^https?:/.test(a.href) && !/doubao\.com|bytedance|byteimg/.test(a.href),
    ).length,
  };
});

console.log(JSON.stringify(out, null, 1));
await browser.close();