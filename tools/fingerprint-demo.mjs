#!/usr/bin/env node
/**
 * 有头演示：连续冷启动 N 次，每轮把这一轮的「设备身份」渲染成一张卡片并截图。
 *
 * 为什么要有这个工具：「指纹换了没有」过去一直靠读日志里的几个字段来判断，
 * 而卡片是**同一个浏览器里、同一时刻**读出来的全部身份字段 ——
 * 换没换，一眼就能比对，不需要相信任何摘要。
 *
 *   node tools/fingerprint-demo.mjs [轮数]     # 默认 3 轮
 *
 * 页面用 setContent 本地渲染，不访问任何站点。
 */
import "dotenv/config";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { launchBrowserSession } from "../src/browser.js";
import { loadConfig } from "../src/config.js";

const rounds = Number(process.argv[2] ?? 3);
const outDir = path.resolve(".runtime/fingerprint-demo");
mkdirSync(outDir, { recursive: true });

const card = (facts, round, rotation) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>设备身份 #${round}</title>
<style>
  body { margin:0; font:14px/1.5 "Segoe UI", "Microsoft YaHei", sans-serif; background:#0f172a; color:#e2e8f0; }
  .wrap { padding:28px 32px; }
  h1 { font-size:22px; margin:0 0 4px; }
  .sub { color:#94a3b8; margin-bottom:18px; font-size:13px; }
  table { border-collapse:collapse; width:100%; }
  th, td { text-align:left; padding:7px 10px; border-bottom:1px solid #1e293b; vertical-align:top; }
  th { color:#94a3b8; font-weight:600; width:190px; }
  .big { font-size:32px; font-weight:700; color:#38bdf8; }
  .tag { display:inline-block; padding:2px 8px; border-radius:4px; background:#1e293b; margin-right:6px; color:#cbd5e1; }
</style></head><body><div class="wrap">
  <h1>设备身份 #${round}</h1>
  <div class="sub">同一份代码、连续第 ${round} 次冷启动 · 游标 ${rotation?.cursor ?? "—"} · 预设 ${rotation?.preset?.id ?? "—"}</div>
  <div style="margin-bottom:16px">
    <span class="tag">${facts.platform}</span>
    <span class="tag">${facts.screen}</span>
    <span class="tag">${facts.hardwareConcurrency} 核</span>
    <span class="tag">Firefox ${facts.firefox}</span>
  </div>
  <table>
    <tr><th>身份摘要</th><td class="big">${facts.digest}</td></tr>
    <tr><th>navigator.userAgent</th><td>${facts.userAgent}</td></tr>
    <tr><th>navigator.platform</th><td>${facts.platform}</td></tr>
    <tr><th>hardwareConcurrency</th><td>${facts.hardwareConcurrency}</td></tr>
    <tr><th>screen.width x height</th><td>${facts.screen}</td></tr>
    <tr><th>screen.availWidth x height</th><td>${facts.avail}</td></tr>
    <tr><th>innerWidth x innerHeight</th><td>${facts.inner}</td></tr>
    <tr><th>WebGL vendor</th><td>${facts.webglVendor ?? "—"}</td></tr>
    <tr><th>WebGL renderer</th><td>${facts.webglRenderer ?? "—"}</td></tr>
    <tr><th>timezone / language</th><td>${facts.timezone} / ${facts.language}</td></tr>
  </table>
</div></body></html>`;

const seen = new Map();
for (let round = 1; round <= rounds; round += 1) {
  const config = loadConfig({ provider: "qianwen", accountKey: `fingerprint_demo_${round}` });
  const session = await launchBrowserSession(config);
  try {
    const rotation = session.fingerprintRotation;
    const facts = await session.page.evaluate(() => {
      const gl =
        document.createElement("canvas").getContext("webgl") ??
        document.createElement("canvas").getContext("experimental-webgl");
      const debug = gl?.getExtension("WEBGL_debug_renderer_info");
      return {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        hardwareConcurrency: navigator.hardwareConcurrency,
        screen: `${screen.width}x${screen.height}`,
        avail: `${screen.availWidth}x${screen.availHeight}`,
        inner: `${innerWidth}x${innerHeight}`,
        webglVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
        webglRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        language: navigator.language,
        firefox: /Firefox\/(\d+)/.exec(navigator.userAgent)?.[1] ?? "?",
      };
    });
    facts.digest = rotation?.identity?.digest ?? "（未轮换）";

    await session.page.setContent(card(facts, round, rotation), { waitUntil: "load" });
    const shot = path.join(outDir, `round-${round}.png`);
    await session.page.screenshot({ path: shot });

    const repeated = seen.has(facts.digest);
    seen.set(facts.digest, round);
    console.log(
      `[round ${round}] digest=${facts.digest} platform=${facts.platform} screen=${facts.screen} ` +
        `cores=${facts.hardwareConcurrency} webgl=${facts.webglRenderer} ` +
        `${repeated ? `★ 与 round ${seen.get(facts.digest)} 重复` : "（新身份）"}`,
    );
    console.log(`           截图 ${shot}`);

    // 有头模式下停一下，让窗口能被看见；headless 时这 1.5 秒可以忽略。
    await session.page.waitForTimeout(1_500);
  } finally {
    await session.close().catch(() => undefined);
  }
}

console.log(`\n共 ${rounds} 轮，不同身份 ${seen.size} 个，截图目录 ${outDir}`);
