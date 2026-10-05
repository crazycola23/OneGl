import { loadConfig } from "../src/config.js";
import { launchBrowserSession } from "../src/browser.js";

/**
 * 验证「addInitScript 因注册顺序在生产从未执行」这一指控。
 *
 * 指控原文：src/browser.js 的顺序是 newContext → newPage → addInitScript → goto，
 * 而 context.addInitScript 只对之后新建的文档生效，对已 newPage 出来的那个不生效。
 *
 * 这里不依赖任何注入内容，只测行为：生产路径下 setter 是否被销毁。
 * 若8 个 setter 全是 function，说明从未执行；若全是 undefined，说明执行过。
 *
 * 对照组：同一份脚本注册在 newPage 之前，看是否变成 undefined。
 */
const TARGET = "https://example.com/";

async function setterStates(page) {
  return page.evaluate(() => ({
    canvas: typeof window.setCanvasSeed,
    audio: typeof window.setAudioFingerprintSeed,
    font: typeof window.setFontSpacingSeed,
    webglVendor: typeof window.setWebGLVendor,
    webglRenderer: typeof window.setWebGLRenderer,
    ua: typeof window.setNavigatorUserAgent,
    platform: typeof window.setNavigatorPlatform,
    hw: typeof window.setNavigatorHardwareConcurrency,
  }));
}

console.log("########## A. 生产真实路径（launchBrowserSession）##########");
{
  const config = loadConfig({ accountKey: null, provider: "doubao" });
  for (let round = 1; round <= 2; round += 1) {
    const session = await launchBrowserSession(config);
    try {
      await session.page.goto(TARGET, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => undefined);
      const st = await setterStates(session.page);
      const destroyed = Object.values(st).filter((v) => v === "undefined").length;
      console.log(`  轮${round}: 已销毁 ${destroyed}/8 ${JSON.stringify(st)}`);
      console.log(`  init script 长度: ${session.camoufoxInitScript?.length ?? "(已移除该字段)"}`);
    } finally {
      await session.close();
    }
    await new Promise((r) => setTimeout(r, 800));
  }
}

console.log("\n########## B. Playwright addInitScript 语义对照 ##########");
console.log("（用 chromium 验证 Playwright 本身的语义：注册顺序是否影响生效）");
{
  const { chromium } = await import("playwright-core");
  // 先注册 setter 定义，再注册调用脚本 —— 两者顺序固定，只变 addInitScript 的时机
  const define = "window.__probeSetter = function () { window.__called = true; };";
  const invoke = "(function(){ if (typeof window.__probeSetter === 'function') window.__probeSetter(); })();";
  const browser = await chromium.launch({ headless: true });

  for (const timing of ["before-newPage", "after-newPage"]) {
    const ctx = await browser.newContext();
    if (timing === "before-newPage") {
      await ctx.addInitScript({ content: define });
      await ctx.addInitScript({ content: invoke });
    }
    const page = await ctx.newPage();
    if (timing === "after-newPage") {
      await ctx.addInitScript({ content: define });
      await ctx.addInitScript({ content: invoke });
    }
    await page.goto("https://example.com/", { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => undefined);
    const r = await page.evaluate(() => ({
      setterType: typeof window.__probeSetter,
      called: window.__called === true,
    }));
    console.log(`  ${timing.padEnd(15)} setter=${r.setterType} 注入脚本已执行=${r.called}`);
    await ctx.close();
  }
  await browser.close();
}