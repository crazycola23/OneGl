import "dotenv/config";
import { launchBrowserSession } from "../src/browser.js";
import { loadConfig } from "../src/config.js";

/**
 * 采集一次 Camoufox 启动后的设备指纹摘要。
 *
 * 用来验证"重启浏览器换指纹"是不是真的成立：它在同一个进程里冷启动两次，
 * 把两次的摘要并排打出来。**不是**产品代码，只是把 browser.js 的行为钉成可观察的输出。
 *
 *   node tools/capture-fingerprint.mjs [启动次数]
 */

async function fingerprintOf(page) {
  return page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 240;
    canvas.height = 60;
    const ctx = canvas.getContext("2d");
    ctx.textBaseline = "top";
    ctx.font = "14px Arial";
    ctx.fillStyle = "#f60";
    ctx.fillRect(0, 0, 120, 20);
    ctx.fillStyle = "#069";
    ctx.fillText("onegl-fingerprint-probe", 2, 15);

    const gl = document.createElement("canvas").getContext("webgl");
    const debug = gl?.getExtension("WEBGL_debug_renderer_info");

    return {
      canvas: canvas.toDataURL().slice(-64),
      webglVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
      webglRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory ?? null,
      maxTouchPoints: navigator.maxTouchPoints,
      screen: `${screen.width}x${screen.height}`,
      availScreen: `${screen.availWidth}x${screen.availHeight}`,
      inner: `${innerWidth}x${innerHeight}`,
      outer: `${outerWidth}x${outerHeight}`,
      // 采集是在这个 viewport 里发生的：screen 比它小就意味着窗口装不下，页面会滚动、
      // 悬浮元素会落到可视区外，而适配器是按元素可见/可点来判定会话状态的。
      viewportDoc: `${document.documentElement.clientWidth}x${document.documentElement.clientHeight}`,
      userAgent: navigator.userAgent,
      language: navigator.language,
      languages: navigator.languages.join(","),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      offsetMinutes: new Date().getTimezoneOffset(),
      platform: navigator.platform,
    };
  });
}

const rounds = Number(process.argv[2] ?? 2);
const captures = [];

for (let index = 0; index < rounds; index += 1) {
  const config = loadConfig({ accountKey: "fingerprint_probe", provider: "qianwen" });
  const session = await launchBrowserSession(config);
  const fingerprint = await fingerprintOf(session.page);
  captures.push(fingerprint);
  // profilePath 是回收进程树与临时 profile 的唯一抓手：它为 null 就意味着每次冷启动都会
  // 在 %TEMP% / /tmp 里留下一个完整浏览器 profile，并且孤儿进程树没人收。
  console.log(`\n[round ${index + 1}] profile=${session.profilePath ?? "（未识别，不会被清理）"}`);
  for (const [key, value] of Object.entries(fingerprint)) {
    console.log(`  ${key.padEnd(20)} ${value}`);
  }
  await session.close();
}

const [first, ...rest] = captures;
console.log("\n[diff vs round 1]");
for (const [index, capture] of rest.entries()) {
  const changed = Object.keys(first).filter((key) => first[key] !== capture[key]);
  const stable = Object.keys(first).filter((key) => first[key] === capture[key]);
  console.log(`  round ${index + 2}: 变化 ${changed.join(", ") || "（无）"}`);
  console.log(`  round ${index + 2}: 稳定 ${stable.join(", ")}`);
}
