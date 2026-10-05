import { loadConfig } from "../src/config.js";
import { launchBrowserSession } from "../src/browser.js";

/**
 * 补查第一轮完全没碰到的维度。
 *
 * 第一轮只查了 canvas / screen / navigator / webgl / audio / font，
 * 漏掉的这些同样是平台会采集的指纹面：
 *   - HTTP 请求头（Accept-Language / Sec-CH-UA 等，与 UA 必须自洽）
 *   - Client Hints（navigator.userAgentData）
 *   - WebRTC（IP 泄露，Camoufox 有 setWebRTCIPv4）
 *   - 存储/ Cookie 是否跨会话泄漏（同一台机器的「同一个人」信号）
 *   - profile 目录是否复用
 *   - 2D canvas 之外的绘图指纹、字体枚举真伪
 *   - 插件列表、时区/locale 自洽性
 *
 * 判据：跨会话应当变化的是「设备身份面」，跨会话必须一致的是「账号面」
 * （locale/timezone 属后者，刻意固定）。两者混淆就会得出错误结论。
 */
const ROUNDS = Number(process.argv[2] || 3);
const PROVIDER = "doubao";

async function probe(page, context) {
  const inPage = await page.evaluate(() => {
    const norm = (v) => String(v ?? "");
    // Client Hints
    const uad = navigator.userAgentData
      ? {
          brands: (navigator.userAgentData.brands || []).map((b) => `${b.brand}:${b.version}`).join("|"),
          platform: navigator.userAgentData.platform,
          mobile: navigator.userAgentData.mobile,
          platformVersion: navigator.userAgentData.platformVersion,
          getHighEntropyValues: null,
        }
      : null;
    return {
      ua: navigator.userAgent,
      uaData: uad,
      langs: navigator.languages.join(","),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      tzOffset: new Date().getTimezoneOffset(),
      dateLocale: new Date().toLocaleString(),
      plugins: Array.from(navigator.plugins || []).map((p) => p.name).join("|"),
      mimeTypes: Array.from(navigator.mimeTypes || []).map((m) => m.type).join("|"),
      webdriver: navigator.webdriver,
      // 权限查询行为（headless 常见破绽）
      permissions: "n/a",
      // 硬件
      cores: navigator.hardwareConcurrency,
      memory: navigator.deviceMemory ?? null,
      touch: navigator.maxTouchPoints,
      // 2D canvas 另一组参数（与 fp-deep 的探针图不同，避免撞同样的噪声种子）
      canvas2d: (() => {
        const c = document.createElement("canvas");
        c.width = 300; c.height = 80;
        const x = c.getContext("2d");
        x.textBaseline = "alphabetic";
        x.font = "italic 28px Georgia";
        x.fillStyle = "#123456";
        x.fillText("HgQ2 测试", 6, 40);
        x.globalCompositeOperation = "multiply";
        x.fillStyle = "rgba(255,0,0,0.6)";
        x.beginPath(); x.arc(160, 40, 28, 0, Math.PI * 1.7); x.fill();
        return c.toDataURL().slice(-100);
      })(),
      // WebGL 扩展列表
      webglExtensions: (() => {
        const g = document.createElement("canvas").getContext("webgl");
        if (!g) return null;
        return (g.getSupportedExtensions() || []).length;
      })(),
      // 字体真实枚举（不是 check()，而是量宽度差）
      fontMetricSpread: (() => {
        const c = document.createElement("canvas");
        const x = c.getContext("2d");
        const measure = (font) => {
          x.font = `40px ${font}`;
          return x.measureText("abcdefghijklmnop").width;
        };
        const base = measure("monospace");
        const names = ["Arial", "Courier New", "Georgia", "Impact", "Times New Roman"];
        return names
          .map((n) => `${n}:${Math.abs(measure(`"${n}", monospace`) - base).toFixed(2)}`)
          .join("|");
      })(),
    };
  });

  // 存储面：跨会话是否泄漏
  const storage = await page.evaluate(() => {
    try {
      return {
        cookieCount: document.cookie.split(";").filter(Boolean).length,
        cookieNames: document.cookie.split(";").map((c) => c.split("=")[0].trim()).filter(Boolean).join("|"),
        localStorageKeys: Object.keys(localStorage).sort().join("|"),
        sessionStorageKeys: Object.keys(sessionStorage).sort().join("|"),
        indexedDb: typeof indexedDB !== "undefined" ? "available" : "none",
      };
    } catch (e) {
      return { error: String(e.message).slice(0, 60) };
    }
  });

  const headers = {};
  if (context) {
    // 只记录能安全取到的头，不打印 cookie 值
    try {
      const res = await context.request.get("https://example.com/", { timeout: 20000 });
      for (const key of ["accept-language", "user-agent", "sec-ch-ua", "sec-ch-ua-platform", "sec-fetch-site"]) {
        headers[key] = res.headers()[key] ?? null;
      }
    } catch (e) {
      headers.error = String(e.message).slice(0, 60);
    }
  }

  return { ...inPage, storage, headers };
}

const config = loadConfig({ accountKey: null, provider: PROVIDER });
const rows = [];

for (let round = 1; round <= ROUNDS; round += 1) {
  const session = await launchBrowserSession(config);
  try {
    const r = await probe(session.page, session.context);
    rows.push(r);
    console.log(`\n[round ${round}]`);
    console.log(`  canvas2d      ${r.canvas2d.slice(0, 34)}`);
    console.log(`  cores=${r.cores} mem=${r.memory} touch=${r.touch} webglExt=${r.webglExtensions}`);
    console.log(`  uaData        ${JSON.stringify(r.uaData)}`);
    console.log(`  plugins       ${(r.plugins || "(none)").slice(0, 46)}`);
    console.log(`  mimeTypes     ${(r.mimeTypes || "(none)").slice(0, 46)}`);
    console.log(`  fonts         ${String(r.fontMetricSpread).slice(0, 60)}`);
    console.log(`  storage       ${JSON.stringify(r.storage).slice(0, 80)}`);
    console.log(`  headers       ${JSON.stringify(r.headers).slice(0, 96)}`);
    console.log(`  webdriver=${r.webdriver} tz=${r.tz} langs=${r.langs}`);
  } finally {
    await session.close();
  }
  await new Promise((r) => setTimeout(r, 1200));
}

console.log(`\n================ 补充维度：跨 ${ROUNDS} 轮取值数 ================`);
// 说明：locale/tz/langs/cookie 属「账号面」，跨会话刻意一致；其余应变化或至少不泄漏
const EXPECT_FIXED = new Set([
  "langs", "tz", "tzOffset", "dateLocale", "ua",
  "headers", "storage", "cookieNames",
]);
for (const key of Object.keys(rows[0])) {
  const vals = rows.map((r) => JSON.stringify(r[key]));
  const distinct = new Set(vals).size;
  const shouldBeFixed = EXPECT_FIXED.has(key);
  const mark = shouldBeFixed
    ? distinct === vals.length
      ? " ~ 变了（账号面本应固定）"
      : " ✓ 固定（符合预期）"
    : distinct === vals.length
      ? " ✓ 每会话不同"
      : " ✗ 固定";
  console.log(`  ${String(distinct) + "/" + vals.length} ${key.padEnd(18)} ${mark}`);
}