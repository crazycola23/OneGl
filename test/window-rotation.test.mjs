import assert from "node:assert/strict";
import test from "node:test";

import { camoufoxLaunchPayload } from "../src/browser.js";
import { loadConfig } from "../src/config.js";
import { safetyConfig, shouldRotateContext } from "../src/accounts/safety.js";

function browserConfig(overrides = {}) {
  return loadConfig({
    dataDir: "/tmp/onegl-window-test",
    browser: "camoufox",
    camoufoxMode: "virtual",
    ...overrides,
  });
}

test("Camoufox launch payload agrees with the Playwright context it feeds", () => {
  const config = browserConfig({ locale: "zh-CN", viewportWidth: 1440, viewportHeight: 900 });
  const payload = camoufoxLaunchPayload(config, { mode: "virtual" });

  // Camoufox randomised the OS (and with it UA, font metrics and WebGL vendor) on every
  // launch while the context pinned locale/timezone/viewport, so the two layers described
  // different machines.
  assert.equal(payload.os, config.camoufoxOs);
  assert.equal(payload.locale, config.locale);
  assert.deepEqual(payload.window, [1440, 900]);
  assert.deepEqual(payload.screen_size, { width: 1440, height: 900 });
  assert.equal(
    payload.screen_size.width >= config.viewportWidth,
    true,
    "reported screen must never be smaller than the pinned viewport",
  );
});

test("screen is pinned explicitly instead of inherited from the 1x1 Xvfb display", () => {
  const payload = camoufoxLaunchPayload(browserConfig(), {
    mode: "virtual",
    virtualDisplay: ":42",
  });
  assert.equal(payload.virtual_display, ":42");
  assert.equal(payload.headless, false, "virtual mode runs a real window on Xvfb");
  assert.deepEqual(
    [payload.screen_size.width, payload.screen_size.height],
    [payload.window[0], payload.window[1]],
  );
});

test("headless mode is the only mode that reports headless to Camoufox", () => {
  assert.equal(camoufoxLaunchPayload(browserConfig(), { mode: "headless" }).headless, true);
  assert.equal(camoufoxLaunchPayload(browserConfig(), { mode: "headful" }).headless, false);
});

test("an unpinned viewport is rejected before it reaches the Python launcher", () => {
  assert.throws(
    () => camoufoxLaunchPayload({ camoufoxOs: "windows", viewportWidth: 0, viewportHeight: 900 }),
    /positive integer size/,
  );
});

test("ONEGL_CAMOUFOX_OS is validated and defaults to windows", () => {
  assert.equal(browserConfig().camoufoxOs, "windows");
  assert.equal(browserConfig({ camoufoxOs: " LINUX " }).camoufoxOs, "linux");
  assert.throws(() => browserConfig({ camoufoxOs: "solaris" }), /must be windows, macos, or linux/);
});

test("window rotation fires on the configured prompt count only", () => {
  assert.equal(shouldRotateContext(0, 3), false);
  assert.equal(shouldRotateContext(2, 3), false);
  assert.equal(shouldRotateContext(3, 3), true, "the limit is inclusive of the served prompts");
  assert.equal(shouldRotateContext(1, 0), false, "0 disables rotation entirely");
  assert.equal(shouldRotateContext(99, null), false);
  assert.equal(safetyConfig().roundPromptLimit, Number(process.env.ONEGL_ROUND_PROMPT_LIMIT ?? 3));
});
