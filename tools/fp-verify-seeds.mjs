import { execFileSync } from "node:child_process";
import { firefox } from "playwright-core";
import { readFileSync } from "node:fs";

/**
 * 独立验证三件事，每件都要能给出「种子固定时恒定 / 种子变化时改变」的证据：
 *
 * 1. canvas **像素**是否随 canvas:seed 变化
 *    这是推翻我此前结论的关键。我此前只读 toDataURL().slice(-90)，
 *    那是 PNG 编码尾部，含逐文档扰动，未必反映 canvas 像素本身。
 *
 * 2. 音频是否随 audio:seed 变化（用 OfflineAudioContext）
 *    我此前用实时 AudioContext + AnalyserNode 读 bins 0-5，在无音频设备容器里
 *    全 -Infinity，且 10kHz 落在 128 点 FFT 的 bin 0-5(<1.7kHz) 之外 —— 测法有缺陷。
 *
 * 3. fonts 列表与 fonts:spacing_seed 各自是否生效
 *    用 canvas measureText 差值（document.fonts.check 恒 true，无效）。
 *
 * 本容器三个坑（第二种子代理踩过并给出绕法）：
 *   - page.evaluate 跑在隔离世界，拿不到 AudioBuffer 的 TypedArray（Xray 报错）
 *     => 页面脚本用 addScriptTag 装进主世界，结果经 DOM 属性回传
 *   - AudioContext 无设备恒 suspended => 音频一律用 OfflineAudioContext
 *   - document.fonts.check / DOM 测宽无效 => 字体只用 canvas measureText
 */

const PY = "/opt/camoufox/bin/python";

// 从 browser.js 里提取那段 Python，避免复制粘贴走样
function pythonOptionsScript() {
  const src = readFileSync("src/browser.js", "utf8");
  const m = src.match(/const CAMOUFOX_OPTIONS_SCRIPT = String\.raw`([\s\S]*?)`;/);
  if (!m) throw new Error("未能提取 CAMOUFOX_OPTIONS_SCRIPT");
  return m[1];
}
const PY_SCRIPT = pythonOptionsScript();

/** 在 Python 侧覆盖指定种子，从而做「只改一个变量」的对照 */
function makeOptions(seedOverrides) {
  const payload = {
    headless: true,
    os: "windows",
    locale: "zh-CN",
    window: [1440, 900],
    screen_size: { width: 1440, height: 900 },
  };
  // 把覆盖逻辑插到 launch_options() 之后、print 之前：
  // 先按正常流程拿到 options，再改写 CAMOU_CONFIG_1 里指定的键。
  const patched = PY_SCRIPT.replace(
    "options[\"onegl_fingerprint_config\"] = cfg",
    `
cfg.update(json.loads(os.environ["ONEGL_SEED_OVERRIDES"]))
options["env"]["CAMOU_CONFIG_1"] = json.dumps(cfg)
options["onegl_fingerprint_config"] = cfg
`,
  );
  if (patched === PY_SCRIPT) throw new Error("插入点未找到，browser.js 结构可能已变");
  // execFileSync 返回的是 stdout 字符串本身，不是 { stdout } 对象
  const out = execFileSync(PY, ["-c", patched], {
    env: {
      ...process.env,
      ONEGL_CAMOUFOX_PAYLOAD: JSON.stringify(payload),
      ONEGL_SEED_OVERRIDES: JSON.stringify(seedOverrides ?? {}),
    },
    encoding: "utf8",
  });
  return JSON.parse(out.trim());
}

/** 页面侧测量：全部经 addScriptTag 注入主世界，结果写 DOM 属性回传 */
const PAGE_PROBE = `
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h >>> 0;
}
(async () => {
  // --- canvas 像素 ---
  const c = document.createElement("canvas");
  c.width = 200; c.height = 60;
  const x = c.getContext("2d");
  x.textBaseline = "top";
  x.font = "16px Arial";
  x.fillStyle = "#f60"; x.fillRect(5, 5, 120, 22);
  x.fillStyle = "#069"; x.fillText("probe 中文", 4, 22);
  const img = x.getImageData(0, 0, 200, 60).data;
  let pixelSum = 0;
  for (let i = 0; i < img.length; i += 4) pixelSum = (pixelSum + img[i] * 3 + img[i+1] * 5 + img[i+2] * 7) | 0;
  // 同一页面再画一张，看同文档内是否稳定
  const c2 = document.createElement("canvas");
  c2.width = 200; c2.height = 60;
  const x2 = c2.getContext("2d");
  x2.textBaseline = "top"; x2.font = "16px Arial";
  x2.fillStyle = "#f60"; x2.fillRect(5, 5, 120, 22);
  x2.fillStyle = "#069"; x2.fillText("probe 中文", 4, 22);
  const img2 = x2.getImageData(0, 0, 200, 60).data;
  let pixelSum2 = 0;
  for (let i = 0; i < img2.length; i += 4) pixelSum2 = (pixelSum2 + img2[i] * 3 + img2[i+1] * 5 + img2[i+2] * 7) | 0;

  // --- audio（离线渲染）---
  let audioHash = null, audioErr = null;
  try {
    const actx = new OfflineAudioContext(1, 8192, 44100);
    const osc = actx.createOscillator();
    osc.type = "triangle"; osc.frequency.value = 10000;
    const comp = actx.createDynamicsCompressor();
    comp.threshold.value = -50; comp.knee.value = 40;
    comp.ratio.value = 12; comp.attack.value = 0; comp.release.value = 0.25;
    osc.connect(comp); comp.connect(actx.destination); osc.start(0);
    const buf = await actx.startRendering();
    const ch = buf.getChannelData(0);
    let acc = 0;
    for (let i = 0; i < ch.length; i += 7) acc = (acc + Math.round(ch[i] * 1e6)) | 0;
    audioHash = acc >>> 0;
  } catch (e) { audioErr = String(e.message).slice(0, 60); }

  // --- fonts（canvas measureText 差值）---
  const measure = (font) => {
    const cc = document.createElement("canvas");
    const xx = cc.getContext("2d");
    xx.font = "40px " + font;
    return xx.measureText("abcdefghijklmnopqrstuvwxyz").width;
  };
  const base = measure("monospace");
  const fontSpread = {};
  for (const f of ["Gabriola", "Arial", "Impact", "Cambria Math"]) {
    fontSpread[f] = Math.round((measure('"' + f + '", monospace') - base) * 100) / 100;
  }

  const result = {
    pixelSum, pixelSum2, sameDocumentStable: pixelSum === pixelSum2,
    dataUrlTail: c.toDataURL().slice(-60),
    audioHash, audioErr, fontSpread,
  };
  document.title = JSON.stringify(result);
})();
`;

async function measure(options, { navigations = 1 } = {}) {
  const browser = await firefox.launch({
    executablePath: options.executable_path,
    args: options.args,
    env: options.env,
    firefoxUserPrefs: options.firefox_user_prefs,
    headless: options.headless ?? true,
  });
  const out = [];
  try {
    for (let nav = 0; nav < navigations; nav += 1) {
      const ctx = await browser.newContext({
        locale: "zh-CN",
        timezoneId: "Asia/Shanghai",
        viewport: { width: 1440, height: 900 },
      });
      const page = await ctx.newPage();
      await page.goto("https://example.com/", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => undefined);
      await page.addScriptTag({ content: PAGE_PROBE });
      await page.waitForFunction(() => document.title.startsWith("{"), { timeout: 15000 }).catch(() => undefined);
      const title = await page.title();
      out.push(title.startsWith("{") ? JSON.parse(title) : { error: title.slice(0, 80) });
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  return out;
}

const SCENARIOS = [
  { label: "canvas:seed=111111 (固定)", overrides: { "canvas:seed": 111111, "audio:seed": 424242, "fonts:spacing_seed": 111111 } },
  { label: "canvas:seed=999999 (固定)", overrides: { "canvas:seed": 999999, "audio:seed": 424242, "fonts:spacing_seed": 111111 } },
  { label: "canvas:seed=111111 + audio:seed=777777", overrides: { "canvas:seed": 111111, "audio:seed": 777777, "fonts:spacing_seed": 111111 } },
  { label: "fonts 列表去掉 Gabriola", overrides: { fonts: ["Arial", "Calibri", "Courier New", "Times New Roman"] } },
];

console.log("每个场景启动 2 次浏览器 × 每次 2 个文档\n");
const all = {};
for (const sc of SCENARIOS) {
  const options = makeOptions(sc.overrides);
  const rounds = [];
  for (let i = 0; i < 2; i += 1) {
    rounds.push(await measure(options, { navigations: 2 }));
  }
  all[sc.label] = rounds;
  console.log(`=== ${sc.label} ===`);
  rounds.forEach((docs, i) => {
    docs.forEach((d, j) => {
      console.log(
        `  启动${i + 1} 文档${j + 1}: pixel=${d.pixelSum} audio=${d.audioHash} ` +
          `同文档稳定=${d.sameDocumentStable} Gabriola=${d.fontSpread?.Gabriola}`,
      );
    });
  });
  console.log("");
}

console.log("================ 判定 ================");
const collect = (label, path) =>
  new Set(all[label].flat().map((d) => path(d)).filter((v) => v != null));

const pixelsA = collect("canvas:seed=111111 (固定)", (d) => d.pixelSum);
const pixelsB = collect("canvas:seed=999999 (固定)", (d) => d.pixelSum);
const audioPinned = collect("canvas:seed=111111 (固定)", (d) => d.audioHash);
const audioChanged = collect("canvas:seed=111111 + audio:seed=777777", (d) => d.audioHash);
const gabriolaPresent = collect("canvas:seed=111111 (固定)", (d) => d.fontSpread?.Gabriola);
const gabriolaRemoved = collect("fonts 列表去掉 Gabriola", (d) => d.fontSpread?.Gabriola);

console.log(`  canvas 像素 seed=111111 的取值: ${[...pixelsA].join(", ")}`);
console.log(`  canvas 像素 seed=999999 的取值: ${[...pixelsB].join(", ")}`);
console.log(
  `  => ${pixelsA.size === 1 && pixelsB.size === 1 && [...pixelsA][0] === [...pixelsB][0]
    ? "✗ 像素与 seed 无关 —— canvas 噪声种子根本没生效（推翻我此前的结论）"
    : "✓ 像素随 seed 变化"}`,
);
console.log(`  audio  seed=424242 的取值: ${[...audioPinned].join(", ")}`);
console.log(`  audio  seed=777777 的取值: ${[...audioChanged].join(", ")}`);
console.log(
  `  => ${audioPinned.size === 1 && audioChanged.size === 1 && [...audioPinned][0] !== [...audioChanged][0]
    ? "✓ 音频噪声由 audio:seed 决定 —— 音频是生效的"
    : "✗ 音频与 seed 无关"}`,
);
console.log(`  Gabriola 在列表里: ${[...gabriolaPresent].join(", ")} | 移除后: ${[...gabriolaRemoved].join(", ")}`);
console.log(
  `  => ${[...gabriolaPresent][0] !== [...gabriolaRemoved][0]
    ? "✓ fonts 列表生效（影响字体度量）"
    : "✗ fonts 列表不影响度量"}`,
);