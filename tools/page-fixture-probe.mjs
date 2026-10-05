/**
 * 离线回路：用真实采集保存下来的 page.html 在本地 Chromium 里回放，
 * 跑的就是 src/doubao.js 里那些 page.evaluate 回调本身，不是复制品。
 *
 * 用途：把「采集时判定错误」变成一条可重复的红/绿信号 —— 服务器上每跑一次
 * 就要几分钟且结果不稳定，这里几秒一次、可以逐个 fixture 断言。
 *
 * 用法：
 *   node tools/page-fixture-probe.mjs <fixture.html> [...more.html]
 */

import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const [, , ...files] = process.argv;
if (!files.length) {
  console.error("usage: node tools/page-fixture-probe.mjs <fixture.html> [...]");
  process.exit(2);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ locale: "zh-CN", viewport: { width: 1440, height: 900 } });

for (const file of files) {
  await page.goto(`file:///${file.replace(/\\/g, "/")}`, { waitUntil: "load" });

  const signals = await page.evaluate(() => {
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const toBottom = document.querySelector("#to-bottom-button, [data-testid='to-bottom-button']");
    const stopControls = [...document.querySelectorAll('button, [role="button"]')]
      .filter(visible)
      .filter((el) => /停止生成|停止回答|停止/.test(`${el.getAttribute("aria-label") || ""} ${el.innerText || el.textContent || ""}`))
      .map((el) => el.getAttribute("aria-label") || el.innerText?.trim() || el.textContent?.trim());
    const citationBlock = [...document.querySelectorAll('[data-plugin-identifier*="block_type:10025"]')].filter(visible);
    const citationText = citationBlock.map((el) => (el.innerText || "").replace(/\s+/g, " ").slice(0, 60));
    const citationLinks = citationBlock.flatMap((el) => [...el.querySelectorAll("a[href]")].map((a) => a.href));
    const bodyText = (document.body.innerText || "").replace(/\s+/g, " ");
    return {
      toBottomPresent: Boolean(toBottom),
      toBottomClass: toBottom?.getAttribute("class") ?? null,
      toBottomVisible: toBottom ? visible(toBottom) : false,
      streamingNodes: [...document.querySelectorAll("[data-streaming]")].map((el) => el.getAttribute("data-streaming")),
      stopControls,
      citationBlockCount: citationBlock.length,
      citationText,
      citationLinkCount: new Set(citationLinks).size,
      hasCitationSignal: /搜索\s*(\d+)\s*个关键词[，,、\s]*参考\s*(\d+)\s*篇资料/.test(bodyText),
      inProgressHints: [...document.querySelectorAll("div, span, p, li")]
        .filter((el) => el.childElementCount === 0)
        .filter(visible)
        .map((el) => (el.textContent || "").trim())
        .filter((t) => t.length > 0 && t.length <= 40 && /正在(搜索|思考|生成|查询|读取|分析|整理|执行|编写|获取|规划|联网)/.test(t)),
    };
  });

  console.log(`\n=== ${file} ===`);
  console.log(JSON.stringify(signals, null, 2));
}

await browser.close();
