import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { resolveCamoufoxMode } from "../src/browser.js";
import { loadConfig } from "../src/config.js";

test("Camoufox runtime modes are explicit and validated", () => {
  for (const mode of ["virtual", "headless", "headful"]) {
    const config = loadConfig({
      browser: "camoufox",
      camoufoxMode: mode,
      headless: mode === "headless",
    });
    assert.equal(config.camoufoxMode, mode);
    assert.equal(resolveCamoufoxMode(config), mode);
  }

  assert.equal(resolveCamoufoxMode({ headless: true }), "headless");
  assert.equal(resolveCamoufoxMode({ headless: false }), "headful");
  assert.equal(
    resolveCamoufoxMode({ camoufoxMode: "virtual", headless: true }, { forceHeadful: true }),
    "headful",
  );

  assert.throws(
    () => loadConfig({ browser: "camoufox", camoufoxMode: "invalid" }),
    /ONEGL_CAMOUFOX_MODE must be virtual, headless, or headful/,
  );
});

test("production deployment defaults to Camoufox virtual mode with Xvfb available", async () => {
  const [dockerfile, envFile, compose, kubernetes, browserSource, readinessSource] = await Promise.all([
    readFile("Dockerfile", "utf8"),
    readFile("deploy/.env.production.example", "utf8"),
    readFile("deploy/docker-compose.yml", "utf8"),
    readFile("deploy/kubernetes/onegl.yaml", "utf8"),
    readFile("src/browser.js", "utf8"),
    readFile("src/system/readiness.js", "utf8"),
  ]);

  assert.match(dockerfile, /ONEGL_BROWSER=camoufox/);
  assert.match(dockerfile, /ONEGL_CAMOUFOX_MODE=virtual/);
  assert.match(dockerfile, /ONEGL_CAMOUFOX_PYTHON=\/opt\/camoufox\/bin\/python/);
  assert.match(dockerfile, /cloverlabs-camoufox\[geoip\]/);
  assert.match(dockerfile, /installed_verstr/);
  assert.match(dockerfile, /\bxvfb\b/);
  assert.match(dockerfile, /playwright-core install --with-deps chromium/);
  assert.match(browserSource, /exclude_addons/);
  assert.match(browserSource, /DefaultAddons/);
  assert.match(readinessSource, /camoufoxRuntimeReadiness/);

  assert.match(envFile, /ONEGL_BROWSER=camoufox/);
  assert.match(envFile, /ONEGL_CAMOUFOX_MODE=virtual/);
  assert.match(kubernetes, /ONEGL_BROWSER: camoufox/);
  assert.match(kubernetes, /ONEGL_CAMOUFOX_MODE: virtual/);

  // Remote Auth launches a browser inside the API process, so the API container also
  // needs more than Docker's tiny default /dev/shm allocation.
  assert.match(compose, /api:[\s\S]*?shm_size: "512mb"/);
  assert.match(compose, /worker:[\s\S]*?healthcheck:[\s\S]*?runtime-check\.js[\s\S]*?--role[\s\S]*?worker/);
});
