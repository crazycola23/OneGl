import { loadConfig } from "../src/config.js";
import { launchBrowserSession } from "../src/browser.js";

/**
 * 逐维度核验指纹是否**真正**切换。
 *
 * 方法：每轮冷启动后做两件事，然后对照——
 *   1. 从浏览器进程环境读 CAMOU_CONFIG_1（Camoufox 认为它注入的指纹）
 *   2. 真实导航后从页面读同一批维度（平台实际看到的值）
 *
 * 只看 (1) 会漏掉「配置有但没落到页面」的情况；只看 (2) 会漏掉
 * 「页面变化其实来自别处」。两者必须逐项对照。
 *
 * 维度清单来自 _build_init_script 的 setter 列表 + CAMOU_CONFIG_1 的键，
 * 少一个就可能漏掉一个静默失效的注入点。
 */
const ROUNDS = Number(process.argv[2] || 4);
const TARGET = "https://example.com/";

/** 页面侧读取：与 Camoufox setter 一一对应 */
async function readPage(page) {
  return page.evaluate(() => {
    const norm = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
    const canvasHash = (() => {
      const c = document.createElement("canvas");
      c.width = 220;
      c.height = 60;
      const x = c.getContext("2d");
      x.textBaseline = "top";
      x.font = "16px Arial";
      x.fillStyle = "#f60";
      x.fillRect(10, 5, 100, 20);
      x.fillStyle = "#069";
      x.fillText("probe 中文", 4, 20);
      return c.toDataURL().slice(-90);
    })();
    const gl = (() => {
      const g = document.createElement("canvas").getContext("webgl");
      if (!g) return { vendor: null, renderer: null };
      const d = g.getExtension("WEBGL_debug_renderer_info");
      if (!d) return { vendor: null, renderer: null };
      return {
        vendor: g.getParameter(d.UNMASKED_VENDOR_WEBGL),
        renderer: g.getParameter(d.UNMASKED_RENDERER_WEBGL),
      };
    })();
    // 字体可用性（fonts 列表是否真的被裁剪）
    const probeFonts = ["Arial", "Calibri", "Cambria Math", "SimSun", "MS Gothic", "Helvetica"];
    const fonts = probeFonts.filter((f) => document.fonts.check(`12px "${f}"`));
    // 音频指纹（与 audio:seed 相关，用振荡器输出做代理指标）
    return {
      canvasHash,
      glVendor: gl.vendor,
      glRenderer: gl.renderer,
      ua: navigator.userAgent,
      platform: navigator.platform,
      oscpu: navigator.oscpu ?? null,
      hw: navigator.hardwareConcurrency,
      screenW: screen.width,
      screenH: screen.height,
      availW: screen.availWidth,
      colorDepth: screen.colorDepth,
      historyLength: history.length,
      acceptEncoding: navigator.language,
      fonts,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      langs: navigator.languages.join(","),
      dpr: window.devicePixelRatio,
      outerW: window.outerWidth,
      outerH: window.outerHeight,
      screenX: window.screenX,
      webdriver: navigator.webdriver,
    };
  });
}

/**
 * 配置侧读取：Camoufox 实际注入的指纹。
 *
 * 不读 /proc —— 那是上一版探针的错误来源：worker 以 onegl 用户运行时读
 * camoufox 子进程的 environ 会 EACCES，于是静默拿到 null，整列交叉核对失效
 * 却看不出来；而用 root 起浏览器又会被 Camoufox 拒绝（它不允许 root 跑在
 * 别人的 HOME 下）。两条路都走不通。
 *
 * 改为由 launchBrowserSession 直接把注入的那份配置挂在 session 上 ——
 * 那是生成脚本本身的输出，是唯一可靠的对照来源。
 */
function readProcessConfig(session) {
  return session.camoufoxFingerprintConfig ?? null;
}

const config = loadConfig({ accountKey: null, provider: "doubao" });
const rows = [];

for (let round = 1; round <= ROUNDS; round += 1) {
  const session = await launchBrowserSession(config);
  try {
    await session.page
      .goto(TARGET, { waitUntil: "domcontentloaded", timeout: 30_000 })
      .catch(() => undefined);
    const page = await readPage(session.page);
    const proc = readProcessConfig(session);
    if (!proc) throw new Error("session 上没有 camoufoxFingerprintConfig，核对无从做起");
    // 直接确认 setter 还在不在：源码说这些是 self-destruct 的一次性函数，
    // 若 addInitScript 真的执行过，它们在页面里应当已被销毁。
    const setterState = await session.page.evaluate(() => ({
      setCanvasSeed: typeof window.setCanvasSeed,
      setAudioFingerprintSeed: typeof window.setAudioFingerprintSeed,
      setFontSpacingSeed: typeof window.setFontSpacingSeed,
    }));
    rows.push({ page, proc, setterState });
    console.log(
      `[round ${round}] canvas=${page.canvasHash.slice(0, 24)} hw=${page.hw} ` +
        `screen=${page.screenW}x${page.screenH} gl=${String(page.glRenderer).slice(0, 26)}`,
    );
    console.log(
      `           cfg: canvas:seed=${proc["canvas:seed"]} hw=${proc["navigator.hardwareConcurrency"]} ` +
        `screen=${proc["screen.width"]}x${proc["screen.height"]}`,
    );
  } finally {
    await session.close();
  }
  await new Promise((r) => setTimeout(r, 1200));
}

console.log(`\n================ 页面侧各维度 ${ROUNDS} 轮取值数 ================`);
const pageKeys = Object.keys(rows[0].page);
const summary = [];
for (const key of pageKeys) {
  const vals = rows.map((r) => JSON.stringify(r.page[key]));
  const distinct = new Set(vals).size;
  summary.push({ key, distinct, total: vals.length, sample: vals[0]?.slice(0, 40) });
  const mark = key === "webdriver" || key === "tz" || key === "langs" ? "（应当固定）" : "";
  console.log(
    `  ${distinct === vals.length ? "✓换" : "✗固"} ${key.padEnd(14)} ${distinct}/${vals.length}${mark}`,
  );
}

console.log(`\n================ 配置侧（CAMOU_CONFIG_1）各维度 ================`);
const procKeys = rows[0].proc ? Object.keys(rows[0].proc) : [];
for (const key of procKeys) {
  const vals = rows.map((r) => JSON.stringify(r.proc?.[key]));
  const distinct = new Set(vals).size;
  console.log(
    `  ${distinct === vals.length ? "✓换" : "✗固"} ${key.padEnd(28)} ${distinct}/${vals.length}`,
  );
}

console.log(`\n================ 交叉核对：配置说设了什么，页面实际是什么 ================`);
const CROSS = [
  ["navigator.userAgent", "ua"],
  ["navigator.platform", "platform"],
  ["navigator.oscpu", "oscpu"],
  ["navigator.hardwareConcurrency", "hw"],
  ["screen.width", "screenW"],
  ["screen.height", "screenH"],
  ["screen.availWidth", "availW"],
  ["screen.colorDepth", "colorDepth"],
  ["window.history.length", "historyLength"],
  ["window.outerWidth", "outerW"],
  ["window.outerHeight", "outerH"],
  ["window.screenX", "screenX"],
  ["webGl:vendor", "glVendor"],
  ["webGl:renderer", "glRenderer"],
];
let mismatch = 0;
for (const [cfgKey, pageKey] of CROSS) {
  const matches = rows.filter(
    (r) => JSON.stringify(r.proc?.[cfgKey]) === JSON.stringify(r.page[pageKey]),
  ).length;
  const status = matches === rows.length ? "✓一致" : `✗不一致 ${matches}/${rows.length}`;
  if (matches !== rows.length) mismatch += 1;
  console.log(`  ${status.padEnd(16)} ${cfgKey} -> ${pageKey}`);
  if (matches !== rows.length) {
    console.log(`      配置: ${JSON.stringify(rows[0].proc?.[cfgKey])}`);
    console.log(`      页面: ${JSON.stringify(rows[0].page[pageKey])}`);
  }
}
console.log(`\n交叉核对不一致项: ${mismatch}/${CROSS.length}`);

console.log(`\n================ setter 是否真的被执行过 ================`);
console.log(
  "  （源码：这些是一次性函数，self-destruct after first call）",
);
for (const r of rows) {
  console.log(`  ${JSON.stringify(r.setterState)}`);
}
const destroyed = rows.filter((r) => r.setterState.setCanvasSeed === "undefined").length;
console.log(
  `  setCanvasSeed 已销毁 ${destroyed}/${rows.length} 轮 ` +
    `${destroyed === rows.length ? "✓ addInitScript 确实执行过" : "✗ setter 仍在，init script 可能没跑"}`,
);