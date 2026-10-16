import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * 设备身份的轮换与自证。
 *
 * ── 为什么需要这个文件 ──────────────────────────────────────────────
 * 2026-10-16 实测（tools/capture-fingerprint.mjs 3 轮冷启动）：
 *
 *   变化：canvas、hardwareConcurrency（16 / 8 / 12）
 *   稳定：userAgent、webglRenderer、screen、timezone、platform、language
 *
 * 也就是说「重启浏览器换指纹」当时只换了噪声种子 —— 平台用来认设备的字段
 * （UA / 平台 / 屏幕 / 显卡）三次完全一致。根因是 browser.js 用 browserforge
 * 采样后再钉死 os + screen，可变的只剩种子。
 *
 * 现在改成从 Camoufox 自带的 123 个**真实设备预设**里按序取一个（windows 75 /
 * macos 30 / linux 18），每个预设是一台真实机器的完整组合：UA + platform +
 * oscpu + 核数 + 屏幕 + WebGL vendor/renderer + 字体 + 语音。
 *
 * ── 两条硬约束 ────────────────────────────────────────────────────
 * 1. **相邻两次必须不同**：游标单调递增，且启动后核对身份摘要，相同即抛错。
 *    「看起来换了」和「真的换了」的区别，就是这张摘要。
 * 2. **登录态不换**：换身份会让「同一个账号的设备」突变。调用方只在匿名面轮换
 *    （见 browser.js 里按 storedAuth 判定）。
 */

const STATE_FILE = "fingerprint-rotation.json";

/**
 * 避重窗口：组合前先算摘要，命中最近这么多次用过的身份就换下一个游标重算。
 *
 * 组合空间 18,638，窗口 60 时随机撞上的概率约 0.32%/次 —— 但「约」不是「不会」，
 * 而重复的身份对平台是一个很强的信号，所以这里按硬约束处理，不靠概率。
 */
const AVOID_WINDOW = 60;

/** 决定「这是哪台设备」的字段。噪声种子（canvas/audio/fonts）刻意不进来 —— 它们每次都变。 */
const IDENTITY_KEYS = [
  "navigator.userAgent",
  "navigator.platform",
  "navigator.hardwareConcurrency",
  "screen.width",
  "screen.height",
  "webGl:vendor",
  "webGl:renderer",
];

export function rotationStatePath(config = {}) {
  return path.join(config.dataDir ?? ".onegl", "fingerprint", STATE_FILE);
}

export function readRotationState(config = {}) {
  const file = rotationStatePath(config);
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return {
      cursor: Number.isInteger(parsed?.cursor) ? parsed.cursor : 0,
      offset: Number.isInteger(parsed?.offset) ? parsed.offset : null,
      lastDigest: typeof parsed?.lastDigest === "string" ? parsed.lastDigest : null,
      lastPreset: parsed?.lastPreset ?? null,
      history: Array.isArray(parsed?.history) ? parsed.history : [],
    };
  } catch {
    // 缺失或损坏都从 0 开始：轮换状态丢了只会导致「可能重复一次」，
    // 而启动后那次摘要核对会把它抓住。
    return { cursor: 0, offset: null, lastDigest: null, lastPreset: null, history: [] };
  }
}

/**
 * 取下一个游标。**不落盘** —— 落盘发生在启动成功之后（commitRotation），
 * 否则启动失败也会消耗掉一个身份，游标与实际使用情况就对不上了。
 */
export function planRotation(config = {}) {
  const state = readRotationState(config);
  // 随机盐：组合是「按游标确定性」的，所以新建的数据目录如果从游标 1 开始，
  // 每次都会得到同一个身份 —— 2026-10-16 实测踩到过：换了 ONEGL_DATA_DIR 之后
  // 身份摘要与上一轮**逐位相同**，而日志上看起来「轮换成功了」。
  // 盐只在第一次规划时生成一次，之后固定，保证同一台机器上的序列不回头。
  const offset = state.offset ?? Math.floor(Math.random() * 1_000_000);
  return {
    cursor: state.cursor + 1,
    offset,
    presetOffset: state.cursor + 1 + offset,
    previousDigest: state.lastDigest,
    previousPreset: state.lastPreset,
    history: state.history,
    avoidDigests: state.history
      .slice(-AVOID_WINDOW)
      .map((entry) => entry?.digest)
      .filter((digest) => typeof digest === "string" && digest.length > 0),
    statePath: rotationStatePath(config),
  };
}

export function commitRotation(config, plan, { digest, preset, at = new Date().toISOString() }) {
  const file = rotationStatePath(config);
  mkdirSync(path.dirname(file), { recursive: true });
  const history = [
    ...(plan.history ?? []),
    { cursor: plan.cursor, digest, preset, at },
  ].slice(-20);
  writeFileSync(
    file,
    `${JSON.stringify(
      { cursor: plan.cursor, offset: plan.offset ?? null, lastDigest: digest, lastPreset: preset, history },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { cursor: plan.cursor, digest, preset, history };
}

export function identityFields(fingerprintConfig = {}) {
  const fields = {};
  for (const key of IDENTITY_KEYS) {
    const value = fingerprintConfig?.[key];
    if (value != null) fields[key] = value;
  }
  return fields;
}

export function identityDigest(fingerprintConfig = {}) {
  const fields = identityFields(fingerprintConfig);
  if (Object.keys(fields).length === 0) return null;
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex").slice(0, 16);
}

/** 人读摘要：日志里一眼能看出「这次是哪台机器」。 */
export function describeIdentity(fingerprintConfig = {}) {
  const fields = identityFields(fingerprintConfig);
  const ua = String(fields["navigator.userAgent"] ?? "");
  const firefox = /Firefox\/(\d+)/.exec(ua)?.[1] ?? "?";
  return {
    digest: identityDigest(fingerprintConfig),
    platform: fields["navigator.platform"] ?? null,
    firefox,
    cores: fields["navigator.hardwareConcurrency"] ?? null,
    screen: fields["screen.width"] && fields["screen.height"]
      ? `${fields["screen.width"]}x${fields["screen.height"]}`
      : null,
    webgl: fields["webGl:renderer"] ?? null,
  };
}

/**
 * 页面读数 vs 注入配置。
 *
 * 配置里写了什么不等于浏览器真的报了什么 —— 中间隔着 Camoufox 的 C++ 层、
 * Playwright 的 context 选项和 Firefox 自己的默认值。这里只比对我们能确定性
 * 控制的字段，比不上的就是「伪装没生效」，必须响亮地失败而不是静默降级。
 */
export function spoofMismatches(fingerprintConfig = {}, facts = {}) {
  const checks = [
    ["navigator.userAgent", fingerprintConfig["navigator.userAgent"], facts.userAgent],
    ["navigator.platform", fingerprintConfig["navigator.platform"], facts.platform],
    [
      "navigator.hardwareConcurrency",
      fingerprintConfig["navigator.hardwareConcurrency"],
      facts.hardwareConcurrency,
    ],
    [
      "screen",
      fingerprintConfig["screen.width"] && fingerprintConfig["screen.height"]
        ? `${fingerprintConfig["screen.width"]}x${fingerprintConfig["screen.height"]}`
        : null,
      facts.screen ?? null,
    ],
  ];
  return checks
    .filter(([, expected, actual]) => expected != null && actual != null && String(expected) !== String(actual))
    .map(([field, expected, actual]) => ({ field, expected: String(expected), actual: String(actual) }));
}
