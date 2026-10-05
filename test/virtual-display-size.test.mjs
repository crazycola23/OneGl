/**
 * Xvfb 虚拟屏尺寸的契约。
 *
 * 这条锁的是一个**静默失效**级别的缺陷（教训文档第一整节都在讲这类）：
 * 1×1 屏下页面静止时合成器不出帧，rAF 每 2 秒只推进 1 帧，而 Playwright
 * `click()` 的前置校验里有 `stable` 检查 —— 它用 rAF 轮询矩形稳定性，
 * 帧推不动就永远过不去，于是 click 死等到超时。
 *
 * 现象链：tryClickSend 恒 false → 全部落 Enter 回退 → sentByButton=false
 * → DOUBAO_SUBMIT_DEGRADED。看起来像「选择器不对」，实际是屏尺寸不对。
 *
 * 实测四档（.ops/compare-xvfb-screens.mjs，2026-10-05）：
 *   1x1x24 → 静置 2s 推进 1 帧 → click 超时 5004ms
 *   1440x900x24 → 119 帧 → click 237ms
 *   1920x1080x24 → 55 帧 → click 258ms
 *   2560x1440x24 → 17 帧 → click 406ms
 *
 * 同时钉住「改它不动指纹」这个前提：四档下页面侧 screen/outer/inner 完全一致，
 * 声明的 screen 由 camoufoxScreenWidth/Height 独立钉在 1920×1080。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/browser.js", import.meta.url), "utf8");

test("Xvfb 默认屏尺寸不得是 1x1（rAF 饿死会让所有 click 死等超时）", () => {
  assert.doesNotMatch(
    source,
    /CAMOUFOX_VIRTUAL_DISPLAY_SIZE\s*\|\|\s*"1x1x24"/,
    "1×1 屏是实测失效值：静置 2s 只推进 1 帧，Playwright click() 的 stable 判定永远过不去",
  );
  assert.match(
    source,
    /CAMOUFOX_VIRTUAL_DISPLAY_SIZE\s*\|\|\s*"1440x900x24"/,
    "默认应是实测最优的 1440x900x24（119 帧 / click 237ms）",
  );
});

test("虚拟屏尺寸仍可由环境变量覆盖（保留回退对照的能力）", () => {
  assert.match(
    source,
    /process\.env\.CAMOUFOX_VIRTUAL_DISPLAY_SIZE\s*\|\|/,
    "必须保留环境变量覆盖，否则无法回到旧值做对照实验",
  );
});

test("改动理由写进注释：包含实测帧数，避免以后被当成随手写的默认值改回去", () => {
  // 注释是这条契约的一部分 —— 没有实测数字，下一个读代码的人会以为它只是
  // 一个随手挑的默认值，于是"改成更小的省资源"。
  const block = source.slice(
    source.indexOf("virtualScreenSize") - 2000,
    source.indexOf("virtualScreenSize") + 400,
  );
  assert.match(block, /119\s*帧/, "应记录实测帧数");
  assert.match(block, /stable/, "应记录 Playwright stable 判定这个真实机制");
  assert.match(block, /不改变页面侧读数/, "应记录「改它不动指纹」这个前提");
});