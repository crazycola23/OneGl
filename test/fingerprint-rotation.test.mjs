import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveFingerprintRotation } from "../src/browser.js";
import {
  commitRotation,
  describeIdentity,
  identityDigest,
  planRotation,
  rotationStatePath,
  spoofMismatches,
} from "../src/fingerprint-rotation.js";

function deviceConfig(overrides = {}) {
  return {
    "navigator.userAgent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0",
    "navigator.platform": "Win32",
    "navigator.hardwareConcurrency": 6,
    "screen.width": 1920,
    "screen.height": 1080,
    "webGl:vendor": "Google Inc. (Intel)",
    "webGl:renderer": "ANGLE (Intel, Intel(R) HD Graphics 400 Direct3D11 vs_5_0 ps_5_0)",
    "canvas:seed": 111,
    "audio:seed": 222,
    ...overrides,
  };
}

test("身份摘要只看设备身份，不看噪声种子", () => {
  const base = identityDigest(deviceConfig());
  assert.equal(base, identityDigest(deviceConfig({ "canvas:seed": 999, "audio:seed": 888 })));

  // 换任何一项「平台用来认设备」的字段，摘要都必须变
  for (const [key, value] of [
    ["navigator.userAgent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0"],
    ["navigator.platform", "MacIntel"],
    ["navigator.hardwareConcurrency", 12],
    ["screen.width", 1536],
    ["webGl:renderer", "ANGLE (AMD, Radeon HD 3200 Graphics Direct3D11 vs_5_0 ps_5_0)"],
  ]) {
    assert.notEqual(identityDigest(deviceConfig({ [key]: value })), base, key);
  }
});

test("游标单调递增，且携带上一次的身份摘要用于事后核对", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "onegl-rotation-"));
  const config = { dataDir };

  const first = planRotation(config);
  assert.equal(first.cursor, 1);
  assert.equal(first.previousDigest, null);
  // 只规划不落盘：启动失败不该消耗掉一个身份
  assert.equal(planRotation(config).cursor, 1);

  commitRotation(config, first, { digest: "aaaa1111", preset: { id: "windows-0" } });
  const second = planRotation(config);
  assert.equal(second.cursor, 2);
  assert.equal(second.previousDigest, "aaaa1111");

  const state = JSON.parse(readFileSync(rotationStatePath(config), "utf8"));
  assert.equal(state.cursor, 1);
  assert.equal(state.lastDigest, "aaaa1111");
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].preset.id, "windows-0");
});

test("轮换状态损坏时从 0 重来，而不是让启动失败", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "onegl-rotation-bad-"));
  const config = { dataDir };
  commitRotation(config, planRotation(config), { digest: "dddd", preset: null });
  // 人为写坏
  const file = rotationStatePath(config);
  writeFileSync(file, "{ not json", "utf8");
  assert.equal(planRotation(config).cursor, 1);
});

test("人读摘要能一眼看出这是哪台机器", () => {
  const described = describeIdentity(deviceConfig());
  assert.equal(described.platform, "Win32");
  assert.equal(described.firefox, "152");
  assert.equal(described.cores, 6);
  assert.equal(described.screen, "1920x1080");
  assert.match(described.webgl, /Intel/);
  assert.equal(described.digest, identityDigest(deviceConfig()));
});

test("页面读数与注入配置不一致时必须被抓出来", () => {
  assert.deepEqual(
    spoofMismatches(deviceConfig(), {
      userAgent: deviceConfig()["navigator.userAgent"],
      platform: "Win32",
      hardwareConcurrency: 6,
      screen: "1920x1080",
    }),
    [],
  );

  const mismatches = spoofMismatches(deviceConfig(), {
    userAgent: deviceConfig()["navigator.userAgent"],
    platform: "Linux x86_64",
    hardwareConcurrency: 4,
    screen: "1280x720",
  });
  assert.deepEqual(
    mismatches.map((item) => item.field).sort(),
    ["navigator.hardwareConcurrency", "navigator.platform", "screen"],
  );
  // 读不到的字段不算「不一致」—— 那是没观测到，不是观测到错的
  assert.deepEqual(spoofMismatches(deviceConfig(), { userAgent: null }), []);
});

test("匿名面轮换、登录态不轮换，环境变量可以覆盖", () => {
  assert.equal(resolveFingerprintRotation({}, { hasStoredAuth: false }), "rotate");
  assert.equal(resolveFingerprintRotation({}, { hasStoredAuth: true }), "keep");
  assert.equal(resolveFingerprintRotation({ fingerprintRotation: "off" }, { hasStoredAuth: false }), "keep");
  assert.equal(resolveFingerprintRotation({ fingerprintRotation: "force" }, { hasStoredAuth: true }), "rotate");
  assert.equal(resolveFingerprintRotation({}, { requested: "keep", hasStoredAuth: false }), "keep");
});
