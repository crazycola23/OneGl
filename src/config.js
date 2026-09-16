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

export function loadConfig(overrides = {}) {
  const dataDir = path.resolve(
    overrides.dataDir ?? process.env.ONEGL_DATA_DIR ?? ".onegl",
  );
  const browser = (
    overrides.browser ?? process.env.ONEGL_BROWSER ?? "camoufox"
  ).toLowerCase();

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

  if (!new Set(["camoufox", "chromium", "firefox"]).has(browser)) {
    throw new Error("ONEGL_BROWSER must be camoufox, chromium, or firefox");
  }

  const authStatePath =
    accountKey === null
      ? path.join(dataDir, "auth", "doubao.storage.json")
      : path.join(dataDir, "auth", "accounts", `${accountKey}.storage.json`);

  return {
    dataDir,
    accountKey,
    // authStatePath is retained as the legacy plaintext location so an existing install can
    // migrate without forcing the operator to log in again. With ONEGL_STORAGE_STATE_KEY set,
    // new writes go to authStateEncryptedPath and the plaintext file is removed.
    authStatePath,
    authStateEncryptedPath: `${authStatePath}.enc`,
    storageStateKey:
      overrides.storageStateKey ?? process.env.ONEGL_STORAGE_STATE_KEY ?? null,
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
    camoufoxPython:
      overrides.camoufoxPython ??
      process.env.ONEGL_CAMOUFOX_PYTHON ??
      "python3",
    headless:
      overrides.headless ?? boolEnv(process.env.ONEGL_HEADLESS, false),
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
