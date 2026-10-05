/**
 * 单独验证 fonts:spacing_seed —— commit 9a5288b 明确标注它「未单独验证」。
 *
 * 那一轮验证的是 fonts **列表**（拿掉 Gabriola 后字体度量归零），以及
 * canvas:seed / audio:seed。这三项是三个不同机制，但 spacing_seed 是第四个：
 * 它不增删字体，而是给每个字形度量加一个按字体名派生的微扰。同一个浏览器里
 * 字体列表完全不变、只改 spacing_seed，如果度量随之变化就说明它真的在生效。
 *
 * 测法（对齐 fp-verify-seeds.mjs 已验证的路径）：
 *   - 在 Python 侧改写 CAMOU_CONFIG_1 的 fonts:spacing_seed，其余全部 pin 死
 *   - 页面侧用 canvas measureText 读宽度（document.fonts.check 恒 true，无效）
 *   - 同一 seed 多轮必须恒定；换 seed 必须改变
 *
 *   node tools/fp-verify-spacing.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { firefox } from "playwright-core";

const PY = "/opt/camoufox/bin/python";

function pythonOptionsScript() {
  const src = readFileSync("src/browser.js", "utf8");
  const m = src.match(/const CAMOUFOX_OPTIONS_SCRIPT = String\.raw`([\s\S]*?)`;/);
  if (!m) throw new Error("未能提取 CAMOUFOX_OPTIONS_SCRIPT");
  return m[1];
}
const PY_SCRIPT = pythonOptionsScript();

function makeOptions(overrides) {
  const payload = {
    headless: true,
    os: "windows",
    locale: "zh-CN",
    window: [1440, 900],
    screen_size: { width: 1920, height: 1080 },
  };
  const patched = PY_SCRIPT.replace(
    'options["onegl_fingerprint_config"] = cfg',
    `
cfg.update(json.loads(os.environ["ONEGL_SEED_OVERRIDES"]))
options["env"]["CAMOU_CONFIG_1"] = json.dumps(cfg)
options["onegl_fingerprint_config"] = cfg
`,
  );
  if (patched === PY_SCRIPT) throw new Error("插入点未找到，browser.js 结构可能已变");
  const out = execFileSync(PY, ["-c", patched], {
    env: {
      ...process.env,
      ONEGL_CAMOUFOX_PAYLOAD: JSON.stringify(payload),
      ONEGL_SEED_OVERRIDES: JSON.stringify(overrides ?? {}),
    },
    encoding: "utf8",
  });
  return JSON.parse(out.trim());
}

// 字体列表钉死：只让 spacing_seed 变，唯一变量就是它本身。
const PINNED_FONTS = [
  "Arial", "Calibri", "Cambria Math", "Consolas", "Courier New", "Georgia",
  "Segoe UI", "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana",
  "Microsoft YaHei", "SimSun", "Impact", "Gabriola",
];

const PAGE_PROBE = `
(() => {
  const measure = (font) => {
    const c = document.createElement("canvas");
    const x = c.getContext("2d");
    x.font = "40px " + font;
    return x.measureText("abcdefghijklmnopqrstuvwxyz0123456789").width;
  };
  const out = {};
  for (const f of ${JSON.stringify(PINNED_FONTS)}) {
    const base = measure("monospace");
    out[f] = Math.round((measure('"' + f + '", monospace') - base) * 1000) / 1000;
  }
  document.title = JSON.stringify(out);
})();
`;

async function measure(options, navigations = 2) {
  const browser = await firefox.launch({
    executablePath: options.executable_path,
    args: options.args,
    env: options.env,
    firefoxUserPrefs: options.firefox_user_prefs,
    headless: options.headless ?? true,
  });
  const rows = [];
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
      const t = await page.title();
      rows.push(t.startsWith("{") ? JSON.parse(t) : { error: t.slice(0, 80) });
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  return rows;
}

const SCENARIOS = [
  { label: "spacing_seed=111111 固定", over: { fonts: PINNED_FONTS, "fonts:spacing_seed": 111111, "canvas:seed": 424242, "audio:seed": 424242 } },
  { label: "spacing_seed=999999 固定", over: { fonts: PINNED_FONTS, "fonts:spacing_seed": 999999, "canvas:seed": 424242, "audio:seed": 424242 } },
];

const all = {};
for (const sc of SCENARIOS) {
  const options = makeOptions(sc.over);
  const rounds = [];
  for (let i = 0; i < 2; i += 1) rounds.push(await measure(options, 2));
  all[sc.label] = rounds;
  console.log(`=== ${sc.label} ===`);
  rounds.forEach((docs, i) => {
    docs.forEach((d, j) => {
      const vals = d && !d.error ? Object.entries(d).map(([k, v]) => `${k}=${v}`).join(" ") : JSON.stringify(d);
      console.log(`  启动${i + 1} 文档${j + 1}: ${vals}`);
    });
  });
  console.log("");
}

console.log("================ 判定 ================");
const flat = (label) => all[label].flat().filter((d) => d && !d.error);
const a = flat(SCENARIOS[0].label);
const b = flat(SCENARIOS[1].label);

let changedFonts = [];
let stableA = true;
for (const f of PINNED_FONTS) {
  const setA = new Set(a.map((d) => d[f]));
  const setB = new Set(b.map((d) => d[f]));
  if (setA.size !== 1) stableA = false;
  if (JSON.stringify([...setA].sort()) !== JSON.stringify([...setB].sort())) changedFonts.push(f);
}

console.log(`seed=111111 内部是否恒定: ${stableA ? "是" : "否（种子固定仍有漂移）"}`);
console.log(`换 seed 后变化的字体: ${changedFonts.length ? changedFonts.join(", ") : "（无）"}`);
console.log(
  stableA && changedFonts.length
    ? "✓ fonts:spacing_seed 生效 —— 字体列表不变时度量仍随种子改变"
    : "✗ fonts:spacing_seed 未生效（列表固定下度量不随种子变）",
);