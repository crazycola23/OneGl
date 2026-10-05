/**
 * 锁定「声称的屏幕尺寸真的被 browserforge 采纳了」这一条。
 *
 * 为什么需要它：browserforge 在约束与已抽中的 UA 无法共存时，会静默丢掉整个
 * screen 约束（generator.py 里 `filtered_values = {}`），不抛异常、不告警。
 * 2026-10-05 实测：把 screen 钉成 viewport 的 1440x900，40 次里只有 12 次真的
 * 是 1440x900，其余落成 1920x1080 / 2560x1440 / 3072x1728 / 5120x1440 等，而
 * navigator.platform 恒为 Win32 —— 3072x1728 是 MacBook Pro 的 retina 逻辑分辨率，
 * 于是形成「自称 Windows 却报 Mac 屏幕」的矛盾指纹。
 *
 * 之前三轮指纹审计（canvas / audio / fonts）都只验证「噪声维度是否生效」，
 * 没验证「被 pin 的字段是否落库」，所以这个洞一直没被发现。
 *
 *   node tools/fp-screen-guard.mjs [轮数]
 */
import { launchBrowserSession } from "../src/browser.js";
import { loadConfig } from "../src/config.js";

const rounds = Number(process.argv[2] ?? 5);
const rows = [];

for (let index = 0; index < rounds; index += 1) {
  const config = loadConfig({ accountKey: "fp_screen_guard", provider: "qianwen" });
  const session = await launchBrowserSession(config);
  try {
    const cfg = session.camoufoxFingerprintConfig ?? {};
    const page = await session.page.evaluate(() => ({
      screen: `${screen.width}x${screen.height}`,
      platform: navigator.platform,
      ua: navigator.userAgent,
      dpr: window.devicePixelRatio,
    }));
    rows.push({
      cfg: `${cfg["screen.width"]}x${cfg["screen.height"]}`,
      cfgDpr: cfg["screen.pixelDepth"],
      page: page.screen,
      platform: page.platform,
      dpr: page.dpr,
      ua: page.ua.slice(0, 60),
      matches: page.screen === `${cfg["screen.width"]}x${cfg["screen.height"]}`,
      pinned:
        page.screen === `${config.camoufoxScreenWidth}x${config.camoufoxScreenHeight}`,
    });
  } finally {
    await session.close().catch(() => undefined);
  }
}

for (const [i, r] of rows.entries()) {
  console.log(
    `[round ${i + 1}] cfg=${r.cfg} page=${r.page} platform=${r.platform} dpr=${r.dpr} ` +
      `cfg==page=${r.matches} pinned=${r.pinned}`,
  );
  console.log(`           ua=${r.ua}`);
}

const cfgPageMatch = rows.filter((r) => r.matches).length;
const pinned = rows.filter((r) => r.pinned).length;
console.log("");
console.log(`配置与页面一致: ${cfgPageMatch}/${rows.length}`);
console.log(`命中钉住的屏幕: ${pinned}/${rows.length}`);

if (cfgPageMatch !== rows.length) {
  console.log("✗ 配置里的 screen 没有落到页面 —— 指纹注入路径出问题了");
  process.exitCode = 1;
} else if (pinned !== rows.length) {
  console.log("✗ screen 被 browserforge 静默丢弃（约束与 UA 无解）—— 不要以为 pin 住了");
  process.exitCode = 1;
} else {
  console.log("✓ 屏幕尺寸被采纳且与配置一致");
}