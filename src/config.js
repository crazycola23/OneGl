import path from "node:path";

function boolEnv(value, fallback) {
  if (value == null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
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

  return {
    dataDir,
    accountKey,
    authStatePath:
      accountKey === null
        ? path.join(dataDir, "auth", "doubao.storage.json")
        : path.join(dataDir, "auth", "accounts", `${accountKey}.storage.json`),
    doubaoUrl:
      overrides.doubaoUrl ??
      process.env.DOUBAO_URL ??
      "https://www.doubao.com/chat/",
    browser,
    browserExecutable:
      overrides.browserExecutable ?? process.env.ONEGL_BROWSER_EXECUTABLE ?? null,
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
    port: overrides.port ?? intEnv("ONEGL_PORT", 3_100, 1),
  };
}
