import path from "node:path";

function boolEnv(value, fallback) {
  if (value == null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function strEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return fallback;
  return String(raw).trim();
}

function intEnv(name, fallback, min = 1) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }
  return parsed;
}

/**
 * 设备身份轮换模式。
 *
 * 空 / auto = 自动：没有登录态就轮换，有登录态就不轮换（沿用「匿名面换指纹、
 * 登录态不换」这条既有判据）。off 关闭；force 强制。
 */
function rotationEnv(name) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return null;
  const value = String(raw).trim().toLowerCase();
  if (["off", "false", "0", "keep", "none"].includes(value)) return "off";
  if (["force", "always", "on", "true", "1"].includes(value)) return "force";
  if (value === "auto") return null;
  throw new Error(`${name} must be auto, off, or force (got ${JSON.stringify(raw)})`);
}

const PROVIDER_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * 出口自证模式。默认 connect —— 便宜的那条先跑；写错了就报错，不静默降级：
 * 一个拼错的 ONEGL_PROXY_VERIFY_EGRESS 会让整套验收实验失去出口取证。
 */
function egressModeEnv(name) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return "connect";
  const value = String(raw).trim().toLowerCase();
  if (!["connect", "browser", "off"].includes(value)) {
    throw new Error(`${name} must be connect, browser, or off (got ${JSON.stringify(raw)})`);
  }
  return value;
}

/**
 * A provider id is part of the credential identity, so an unchecked value would let a
 * misconfigured env var read (or overwrite) another platform's storage state.
 */
export function normalizeProviderId(value) {
  const provider = String(value ?? "doubao").trim().toLowerCase();
  if (!PROVIDER_PATTERN.test(provider)) {
    throw new Error(
      `Provider ${JSON.stringify(value)} is invalid; expected a lowercase adapter id such as "doubao"`,
    );
  }
  return provider;
}

export function loadConfig(overrides = {}) {
  const dataDir = path.resolve(
    overrides.dataDir ?? process.env.ONEGL_DATA_DIR ?? ".onegl",
  );
  const browser = (
    overrides.browser ?? process.env.ONEGL_BROWSER ?? "camoufox"
  ).toLowerCase();
  const headless =
    overrides.headless ?? boolEnv(process.env.ONEGL_HEADLESS, false);
  const camoufoxMode = String(
    overrides.camoufoxMode ??
      process.env.ONEGL_CAMOUFOX_MODE ??
      (headless ? "headless" : "headful"),
  ).trim().toLowerCase();

  // An account is an anonymous identifier; its storage state is kept in a per-account
  // file so several Doubao profiles stay independent of each other.
  const accountKeyRaw = overrides.accountKey ?? process.env.ONEGL_ACCOUNT ?? null;
  const accountKey =
    accountKeyRaw == null || String(accountKeyRaw).trim() === ""
      ? null
      : String(accountKeyRaw).trim();
  if (accountKey !== null && !/^[A-Za-z0-9._-]{1,64}$/.test(accountKey)) {
    throw new Error(
      `ONEGL_ACCOUNT ${JSON.stringify(accountKey)} is invalid; expected [A-Za-z0-9._-]{1,64}`,
    );
  }

  // One account key can exist on several platforms; the browser session must know which
  // platform's credentials it is loading, otherwise two providers share one state file.
  const provider = normalizeProviderId(
    overrides.provider ?? process.env.ONEGL_ACCOUNT_PROVIDER ?? "doubao",
  );

  if (!new Set(["camoufox", "chromium", "firefox"]).has(browser)) {
    throw new Error("ONEGL_BROWSER must be camoufox, chromium, or firefox");
  }
  if (!new Set(["virtual", "headless", "headful"]).has(camoufoxMode)) {
    throw new Error("ONEGL_CAMOUFOX_MODE must be virtual, headless, or headful");
  }
  // Camoufox otherwise randomises the OS - and with it the UA, font metrics and WebGL
  // vendor - on every launch, so the browser layer has to be pinned to match the locale,
  // timezone and viewport pinned on the Playwright context.
  const camoufoxOs = String(
    overrides.camoufoxOs ?? process.env.ONEGL_CAMOUFOX_OS ?? "windows",
  )
    .trim()
    .toLowerCase();
  if (!new Set(["windows", "macos", "linux"]).has(camoufoxOs)) {
    throw new Error("ONEGL_CAMOUFOX_OS must be windows, macos, or linux");
  }

  const authStatePlaintextPath =
    accountKey === null
      ? path.join(dataDir, "auth", `${provider}.storage.json`)
      : path.join(dataDir, "auth", "accounts", `${provider}__${accountKey}.storage.json`);
  const authStateEncryptedPath = `${authStatePlaintextPath}.enc`;
  // Doubao state predates provider scoping and lives at <account_key>.storage.json. Keep
  // resolving it so a multi-provider deploy does not silently log every account out.
  const authStateLegacyPlaintextPath =
    provider === "doubao" && accountKey !== null
      ? path.join(dataDir, "auth", "accounts", `${accountKey}.storage.json`)
      : null;
  const storageStateKey =
    overrides.storageStateKey ?? process.env.ONEGL_STORAGE_STATE_KEY ?? null;

  return {
    dataDir,
    accountKey,
    provider,
    // Keep both paths explicit: authStatePlaintextPath is only for legacy migration / optional
    // local plaintext mode. authStatePath is the effective destination displayed to operators.
    authStatePlaintextPath,
    authStateEncryptedPath,
    authStateLegacyPlaintextPath,
    authStateLegacyEncryptedPath: authStateLegacyPlaintextPath
      ? `${authStateLegacyPlaintextPath}.enc`
      : null,
    authStatePath:
      storageStateKey == null || String(storageStateKey).trim() === ""
        ? authStatePlaintextPath
        : authStateEncryptedPath,
    storageStateKey,
    requireStorageStateEncryption:
      overrides.requireStorageStateEncryption ??
      boolEnv(process.env.ONEGL_REQUIRE_STORAGE_STATE_ENCRYPTION, false),
    doubaoUrl:
      overrides.doubaoUrl ??
      process.env.DOUBAO_URL ??
      "https://www.doubao.com/chat/",
    browser,
    browserExecutable:
      overrides.browserExecutable ?? process.env.ONEGL_BROWSER_EXECUTABLE ?? null,
    // 代理池配置文件入口（契约见 docs/2026-10-15_proxy-pool-interface-v1.md）。
    // 未设置时保持既有直连行为；一旦设置，读不到或必需池不可用都会在启动浏览器前
    // 抛错，而不是悄悄退回直连 —— 代理故障必须表现为故障。
    proxyPoolFile:
      overrides.proxyPoolFile ?? strEnv("ONEGL_PROXY_POOL_FILE", null),
    // 出口自证模式（见 src/proxy-egress.js）：
    //   connect = 只用 Node 的 CONNECT 探针（约 0.5s），证明这条线路真的能把流量送出去
    //   browser = 额外用页面导航取出口（约 2–4s），取证更强：证明**浏览器**确实走了代理
    //   off     = 不验（只建议在排查探针本身时用）
    // 默认 connect：冷启动 11.4s 的会话再加 2–4s 的导航是 20%+ 的固定开销，
    // 而浏览器级的证明在验收实验时才需要（tools/probe-proxy-egress.mjs 也提供它）。
    proxyVerifyEgress:
      overrides.proxyVerifyEgress ?? egressModeEnv("ONEGL_PROXY_VERIFY_EGRESS"),
    proxyEgressTimeoutMs:
      overrides.proxyEgressTimeoutMs ??
      intEnv("ONEGL_PROXY_EGRESS_TIMEOUT_MS", 15_000, 1_000),
    // 设备身份轮换（见 src/fingerprint-rotation.js）。null = 自动。
    fingerprintRotation:
      overrides.fingerprintRotation ?? rotationEnv("ONEGL_FINGERPRINT_ROTATION"),
    // 身份来源：compose = 把该 OS 的真实屏幕/核数/显卡组合起来（18,638 种）；
    // preset = 整条真实设备记录轮换（123 种，用于对照与回退）。
    fingerprintSource: String(
      overrides.fingerprintSource ?? strEnv("ONEGL_FINGERPRINT_SOURCE", "compose"),
    )
      .trim()
      .toLowerCase(),
    // Context-level environment. These exist so one account presents the *same*
    // browser environment on every cold start: an automation that switches locale,
    // timezone and window size between runs is not behaving like the same user
    // returning, it is behaving like a new device each time. This is consistency,
    // not spoofing - the values are the operator's real locale/timezone.
    locale:
      overrides.locale ?? strEnv("ONEGL_BROWSER_LOCALE", "zh-CN"),
    timezoneId:
      overrides.timezoneId ?? strEnv("ONEGL_BROWSER_TIMEZONE", "Asia/Shanghai"),
    viewportWidth:
      overrides.viewportWidth ?? intEnv("ONEGL_BROWSER_VIEWPORT_WIDTH", 1_440, 320),
    viewportHeight:
      overrides.viewportHeight ?? intEnv("ONEGL_BROWSER_VIEWPORT_HEIGHT", 900, 240),
    // The screen the browser claims, deliberately separate from the viewport above.
    //
    // browserforge silently drops a screen constraint it cannot satisfy together with
    // the user agent it already sampled, so pinning the screen to the viewport size
    // (1440x900) produced a 30% hit rate and otherwise a MacBook-Pro-sized screen
    // under a Win32 UA. 1920x1080 is the mainstream Windows desktop resolution and
    // hit 5/5 across repeated launches. Measured in tools/fp-screen-guard.mjs.
    camoufoxScreenWidth:
      overrides.camoufoxScreenWidth ??
      intEnv("ONEGL_CAMOUFOX_SCREEN_WIDTH", 1_920, 320),
    camoufoxScreenHeight:
      overrides.camoufoxScreenHeight ??
      intEnv("ONEGL_CAMOUFOX_SCREEN_HEIGHT", 1_080, 240),
    camoufoxPython:
      overrides.camoufoxPython ??
      process.env.ONEGL_CAMOUFOX_PYTHON ??
      "python3",
    // Camoufox has a separate runtime mode because production Linux normally wants a
    // headful browser on an Xvfb display, while Chromium/Firefox continue to use the
    // boolean ONEGL_HEADLESS flag. If ONEGL_CAMOUFOX_MODE is omitted, preserve the
    // legacy ONEGL_HEADLESS behaviour for backwards compatibility.
    camoufoxMode,
    camoufoxOs,
    headless,
    timeoutMs:
      overrides.timeoutMs ?? intEnv("DOUBAO_TIMEOUT_MS", 180_000, 10_000),
    pollMs: overrides.pollMs ?? intEnv("DOUBAO_POLL_MS", 1_500, 250),
    stablePolls:
      overrides.stablePolls ?? intEnv("DOUBAO_STABLE_POLLS", 3, 1),
    loginTimeoutMs:
      overrides.loginTimeoutMs ??
      intEnv("DOUBAO_LOGIN_TIMEOUT_MS", 300_000, 30_000),
    // How long to wait for the conversation to prove it is empty before refusing to
    // submit. Overridable so tests can exercise the fail-closed path without waiting.
    conversationSettleMs:
      overrides.conversationSettleMs ??
      intEnv("DOUBAO_CONVERSATION_SETTLE_MS", 15_000, 0),
    // Passive network/SSE evidence is opt-in until a real-account validation run proves
    // the current Doubao stream shape. It never changes visible-citation truth semantics.
    networkEvidenceEnabled:
      overrides.networkEvidenceEnabled ??
      boolEnv(process.env.ONEGL_NETWORK_EVIDENCE, false),
    networkEvidenceMaxBodyBytes:
      overrides.networkEvidenceMaxBodyBytes ??
      intEnv("ONEGL_NETWORK_MAX_BODY_BYTES", 4 * 1024 * 1024, 1_024),
    networkEvidenceBodyTimeoutMs:
      overrides.networkEvidenceBodyTimeoutMs ??
      intEnv("ONEGL_NETWORK_BODY_TIMEOUT_MS", 8_000, 100),
    port: overrides.port ?? intEnv("ONEGL_PORT", 3_100, 1),
  };
}
