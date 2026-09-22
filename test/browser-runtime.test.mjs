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
  const [dockerfile, envFile, compose, kubernetes, browserSource, readinessSource, assetResolver, rangeDownloader, addonInstaller] = await Promise.all([
    readFile("Dockerfile", "utf8"),
    readFile("deploy/.env.production.example", "utf8"),
    readFile("deploy/docker-compose.yml", "utf8"),
    readFile("deploy/kubernetes/onegl.yaml", "utf8"),
    readFile("src/browser.js", "utf8"),
    readFile("src/system/readiness.js", "utf8"),
    readFile("tools/prepare-camoufox-url.py", "utf8"),
    readFile("tools/download-camoufox-range.mjs", "utf8"),
    readFile("tools/install-ublock.py", "utf8"),
  ]);

  assert.match(dockerfile, /m\.daocloud\.io\/docker\.io\/library\/node/);
  assert.match(dockerfile, /APT_MIRROR=http:\/\/mirrors\.aliyun\.com\/debian/);
  assert.match(dockerfile, /NPM_REGISTRY=https:\/\/registry\.npmmirror\.com/);
  assert.match(dockerfile, /PIP_INDEX_URL=https:\/\/pypi\.tuna\.tsinghua\.edu\.cn\/simple/);
  assert.match(dockerfile, /PLAYWRIGHT_DOWNLOAD_HOST=https:\/\/registry\.npmmirror\.com\/\-\/binary\/playwright/);
  assert.match(dockerfile, /ONEGL_BROWSER=camoufox/);
  assert.match(dockerfile, /ONEGL_CAMOUFOX_MODE=virtual/);
  assert.match(dockerfile, /ONEGL_CAMOUFOX_PYTHON=\/opt\/camoufox\/bin\/python/);
  assert.match(dockerfile, /ONEGL_CAMOUFOX_UBLOCK_PATH=\/opt\/onegl-addons\/ublock/);
  assert.match(dockerfile, /UBLOCK_VERSION=1\.75\.0/);
  assert.match(dockerfile, /UBLOCK_VENDOR_SHA256=/);
  assert.match(dockerfile, /cloverlabs-camoufox\[geoip\]/);
  assert.match(dockerfile, /installed_verstr/);
  assert.match(dockerfile, /prepare-camoufox-url\.py/);
  assert.match(dockerfile, /prepare-camoufox-url\.py --install/);
  assert.match(dockerfile, /CAMOUFOX_VENDOR_SHA256/);
  assert.match(dockerfile, /source=vendor\/camoufox-lin\.x86_64\.zip/);
  assert.match(dockerfile, /source=vendor\/ublock-origin\.firefox\.xpi/);
  assert.match(dockerfile, /install-ublock\.py/);
  assert.match(dockerfile, /\bxvfb\b/);
  assert.match(dockerfile, /playwright-core install --with-deps chromium/);
  assert.match(compose, /ONEGL_NODE_BASE_IMAGE: m\.daocloud\.io\/docker\.io\/library\/node/);
  assert.match(compose, /APT_MIRROR: http:\/\/mirrors\.aliyun\.com\/debian/);
  assert.match(compose, /NPM_REGISTRY: https:\/\/registry\.npmmirror\.com/);
  assert.match(compose, /PIP_INDEX_URL: https:\/\/pypi\.tuna\.tsinghua\.edu\.cn\/simple/);
  assert.match(compose, /PLAYWRIGHT_DOWNLOAD_HOST: https:\/\/registry\.npmmirror\.com\/\-\/binary\/playwright/);
  assert.match(browserSource, /exclude_addons/);
  assert.match(browserSource, /DefaultAddons/);
  assert.match(browserSource, /ONEGL_CAMOUFOX_UBLOCK_PATH/);
  assert.match(browserSource, /payload\["addons"\]/);
  assert.match(readinessSource, /camoufoxRuntimeReadiness/);
  assert.match(readinessSource, /uBlock/);
  assert.match(assetResolver, /releases\/assets/);
  assert.match(assetResolver, /application\/octet-stream/);
  assert.match(assetResolver, /CamoufoxFetcher/);
  assert.match(assetResolver, /--archive/);
  assert.match(assetResolver, /subprocess/);
  assert.match(rangeDownloader, /Range:/);
  assert.match(addonInstaller, /EXPECTED_ID/);
  assert.match(addonInstaller, /expected-sha256/);
  assert.match(addonInstaller, /manifest\.json/);

  assert.match(envFile, /ONEGL_BROWSER=camoufox/);
  assert.match(envFile, /ONEGL_CAMOUFOX_MODE=virtual/);
  assert.match(kubernetes, /ONEGL_BROWSER: camoufox/);
  assert.match(kubernetes, /ONEGL_CAMOUFOX_MODE: virtual/);

  // Remote Auth launches a browser inside the API process, so the API container also
  // needs more than Docker's tiny default /dev/shm allocation.
  assert.match(compose, /api:[\s\S]*?shm_size: "512mb"/);
  assert.match(compose, /worker:[\s\S]*?healthcheck:[\s\S]*?runtime-check\.js[\s\S]*?--role[\s\S]*?worker/);
});
