/**
 * 打印本次启动实际注入的 CAMOU_CONFIG_1，并把它与页面读数并排对照。
 *
 * 目的是判定 browser.js 里的注释与现实是否一致：
 *   1) 注释说 canvas/audio/font 噪声每轮会换 —— 页面读数却 3/3 完全相同。
 *   2) 注释说 screen 被 Screen(min=max=viewport) 钉住 —— 页面读数却是 3072x1728。
 *
 *   node tools/probe-fingerprint-config.mjs
 */
import { launchBrowserSession } from "../src/browser.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig({ accountKey: "fp_config_probe", provider: "qianwen" });
const session = await launchBrowserSession(config);

try {
  const cfg = session.camoufoxFingerprintConfig;
  console.log("[config] screen     =", JSON.stringify(cfg?.screen));
  console.log("[config] window     =", JSON.stringify(cfg?.window));
  console.log("[config] canvas     =", JSON.stringify(cfg?.canvas));
  console.log("[config] audio      =", JSON.stringify(cfg?.audio));
  console.log("[config] fonts      =", JSON.stringify(cfg?.fonts));
  console.log("[config] webgl      =", JSON.stringify(cfg?.webgl));
  console.log("[config] navigator  =", JSON.stringify(cfg?.navigator));
  console.log("[config] keys       =", Object.keys(cfg ?? {}).join(","));

  const page = await session.page.evaluate(() => ({
    screen: `${screen.width}x${screen.height}`,
    inner: `${innerWidth}x${innerHeight}`,
    clientWidth: document.documentElement.clientWidth,
    clientHeight: document.documentElement.clientHeight,
    bodyHeight: document.body?.getBoundingClientRect().height ?? null,
    ua: navigator.userAgent,
    platform: navigator.platform,
    devicePixelRatio: window.devicePixelRatio,
  }));
  console.log("[page]  ", JSON.stringify(page, null, 2));
} finally {
  await session.close().catch(() => undefined);
}