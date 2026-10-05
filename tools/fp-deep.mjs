import { loadConfig } from "../src/config.js";
import { launchBrowserSession } from "../src/browser.js";

/**
 * 专查「配置里有、但页面读数不变」的维度。
 *
 * 第一轮审计留下的三个疑点：
 *   1. setCanvasSeed 已销毁，但 setAudioFingerprintSeed / setFontSpacingSeed 仍是
 *      function —— 说明只有 canvas 的 setter 跑了，audio/font 的没跑？
 *   2. 配置里 navigator.maxTouchPoints 3/4 有变化，页面没读它，无法判断
 *   3. fonts 配置 4/4 变，页面 fonts 列表 1/4 固 —— 字体到底进没进页面？
 *
 * 这三个都指向同一类问题：配置层看起来在变，页面层没跟上。
 */
const ROUNDS = Number(process.argv[2] || 4);
const TARGET = "https://example.com/";

async function readDeep(page) {
  return page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl");
    const dbg = gl?.getExtension("WEBGL_debug_renderer_info");

    // 字体：既看 check()，也看实际测量宽度（check() 可能全为 true 但没真装）
    const fontProbe = {};
    const base = {};
    const cvs = document.createElement("canvas");
    const ctx = cvs.getContext("2d");
    for (const f of ["Arial", "Calibri", "Cambria Math", "SimSun", "MS Gothic", "Helvetica"]) {
      ctx.font = `72px monospace`;
      base[f] = ctx.measureText(f).width;
      ctx.font = `72px "${f}", monospace`;
      fontProbe[f] = { width: ctx.measureText(f).width, check: document.fonts.check(`12px "${f}"`) };
    }

    return {
      canvasHash: (() => {
        const c = document.createElement("canvas");
        c.width = 220; c.height = 60;
        const x = c.getContext("2d");
        x.textBaseline = "top"; x.font = "16px Arial";
        x.fillStyle = "#f60"; x.fillRect(10, 5, 100, 20);
        x.fillStyle = "#069"; x.fillText("probe 中文", 4, 20);
        return c.toDataURL().slice(-90);
      })(),
      // 音频：离线渲染一段固定波形，取前几个样本做指纹
      audioSamples: (() => {
        try {
          const actx = new OfflineAudioContext(1, 5000, 44100);
          const osc = actx.createOscillator();
          osc.type = "triangle";
          osc.frequency.value = 10000;
          const comp = actx.createDynamicsCompressor();
          osc.connect(comp); comp.connect(actx.destination);
          osc.start(0);
          const rendered = actx.startRendering();
          // 同步 API 下拿不到 buffer，改用同步的 AnalyserNode 代替：
          return null;
        } catch (e) {
          return `err:${e.message}`;
        }
      })(),
      // 同步版音频指纹：实时 OscillatorNode + AnalyserNode
      audioRealtime: (() => {
        try {
          const actx = new AudioContext();
          const osc = actx.createOscillator();
          osc.type = "triangle";
          osc.frequency.value = 10000;
          const comp = actx.createDynamicsCompressor();
          const an = actx.createAnalyser();
          an.fftSize = 128;
          osc.connect(comp); comp.connect(an); an.connect(actx.destination);
          osc.start();
          const buf = new Float32Array(an.frequencyBinCount);
          an.getFloatFrequencyData(buf);
          osc.stop();
          actx.close();
          return Array.from(buf.slice(0, 6)).map((v) => v.toFixed(6)).join(",");
        } catch (e) {
          return `err:${e.message.slice(0, 40)}`;
        }
      })(),
      fontWidths: Object.fromEntries(Object.entries(fontProbe).map(([k, v]) => [k, v.width])),
      fontChecks: Object.fromEntries(Object.entries(fontProbe).map(([k, v]) => [k, v.check])),
      fontBaseline: base,
      maxTouchPoints: navigator.maxTouchPoints,
      voices: typeof speechSynthesis !== "undefined" ? speechSynthesis.getVoices().length : null,
      webGlRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
      webGlVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
    };
  });
}

const config = loadConfig({ accountKey: null, provider: "doubao" });
const rows = [];

for (let round = 1; round <= ROUNDS; round += 1) {
  const session = await launchBrowserSession(config);
  try {
    await session.page.goto(TARGET, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
    // 等字体加载完再测，否则量到的是 fallback
    await session.page.evaluate(() => document.fonts.ready).catch(() => undefined);
    const deep = await readDeep(session.page);
    const cfg = session.camoufoxFingerprintConfig;
    const setters = await session.page.evaluate(() => ({
      canvas: typeof window.setCanvasSeed,
      audio: typeof window.setAudioFingerprintSeed,
      font: typeof window.setFontSpacingSeed,
      webglVendor: typeof window.setWebGLVendor,
      webglRenderer: typeof window.setWebGLRenderer,
      ua: typeof window.setNavigatorUserAgent,
      hw: typeof window.setNavigatorHardwareConcurrency,
      platform: typeof window.setNavigatorPlatform,
    }));
    rows.push({ deep, cfg, setters });
    console.log(`\n[round ${round}] setters=${JSON.stringify(setters)}`);
    console.log(`  canvas      ${deep.canvasHash.slice(0, 30)}`);
    console.log(`  audioRealtime ${String(deep.audioRealtime).slice(0, 50)}`);
    console.log(
      `  cfg ${cfg ? `audio:seed=${cfg["audio:seed"]} fonts:spacing_seed=${cfg["fonts:spacing_seed"]} fonts.len=${Array.isArray(cfg.fonts) ? cfg.fonts.length : "n/a"}` : "(未暴露，修复前版本)"}`,
    );
  } finally {
    await session.close();
  }
  await new Promise((r) => setTimeout(r, 1200));
}

console.log(`\n================ 深挖结论 ================`);
const dims = [
  ["canvasHash", (r) => r.deep.canvasHash],
  ["audioRealtime", (r) => r.deep.audioRealtime],
  ["fontWidths(Arial)", (r) => JSON.stringify(r.deep.fontWidths.Arial)],
  ["fontWidths(Cambria Math)", (r) => JSON.stringify(r.deep.fontWidths["Cambria Math"])],
  ["fontChecks 全部 true", (r) => JSON.stringify(r.deep.fontChecks)],
  ["maxTouchPoints", (r) => r.deep.maxTouchPoints],
  ["voices", (r) => r.deep.voices],
  ["cfg audio:seed", (r) => r.cfg?.["audio:seed"]],
  ["cfg fonts:spacing_seed", (r) => r.cfg?.["fonts:spacing_seed"]],
  ["cfg fonts 列表", (r) => JSON.stringify(r.cfg?.fonts)],
];
for (const [name, get] of dims) {
  const vals = rows.map((r) => String(get(r)));
  const distinct = new Set(vals).size;
  console.log(`  ${distinct === vals.length ? "✓换" : "✗固"} ${name.padEnd(26)} ${distinct}/${vals.length}`);
}

console.log(`\n================ setter 状态（function=未被调用，undefined=已执行销毁） ================`);
for (const [name, key] of [
  ["canvas", "canvas"], ["audio", "audio"], ["fontSpacing", "font"],
  ["webglVendor", "webglVendor"], ["webglRenderer", "webglRenderer"],
  ["userAgent", "ua"], ["hardwareConcurrency", "hw"], ["platform", "platform"],
]) {
  const states = rows.map((r) => r.setters[key]);
  const destroyed = states.filter((s) => s === "undefined").length;
  console.log(
    `  ${name.padEnd(20)} 已销毁 ${destroyed}/${states.length} ` +
      `${destroyed === states.length ? "✓" : destroyed === 0 ? "✗ 从未执行" : "~ 部分"}`,
  );
}