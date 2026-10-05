import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { chromium } from "playwright-core";
import { extractVisibleCitations } from "../src/doubao.js";

const DIR = "D:/projects/scrm/.onegl-snap/b163";
const browser = await chromium.launch({ headless: true });

for (const tag of ["i2", "i8", "i1"]) {
  const html = readFileSync(`${DIR}/${tag}.html`, "utf8");
  const page = await browser.newPage();
  await page.route("**", (r) => r.abort().catch(() => undefined));
  await page.setContent(html, { waitUntil: "domcontentloaded" });

  const dom = await page.evaluate(() => {
    const norm = (v) => String(v || "").replace(/\s+/g, " ").trim();
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
    };
    const answers = [...document.querySelectorAll(
      '.md-box-root, [class*="md-box-root"], [data-testid="message_text_content"], ' +
      '[data-testid="message_content"], .flow-markdown-body',
    )].filter(visible);
    const allAnchors = [...document.querySelectorAll("a[href]")].filter(visible);
    const external = allAnchors.filter((a) => /^https?:/.test(a.href) && !/doubao\.com|bytedance|byteimg/.test(a.href));
    return {
      answers: answers.length,
      answerChars: answers.map((a) => norm(a.innerText).length),
      block10025: document.querySelectorAll('[data-plugin-identifier*="block_type:10025"]').length,
      totalExternalLinks: external.length,
      externalHosts: [...new Set(external.slice(0, 6).map((a) => new URL(a.href).host))],
      hasSearchText: /搜索\s*\d+\s*个关键词/.test(document.body.innerText || ""),
      // 页面里有没有任何形式的来源区标题
      referenceHints: (document.body.innerText.match(/参考资料|来源列表|资料来源|参考来源/g) || []).length,
    };
  });

  const result = await extractVisibleCitations(page);
  console.log(`\n[${tag}]`);
  console.log("  DOM      ", JSON.stringify(dom));
  console.log("  EXTRACT  ", JSON.stringify({
    state: result.state, n: result.citations.length, exp: result.expectedCount,
    diag: result.diagnostics, sourceBlockFound: result.sourceBlockFound,
  }));
  await page.close();
}
await browser.close();