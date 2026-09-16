import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium, firefox } from "playwright-core";
import { DoubaoMvpError, ErrorCode } from "./errors.js";
import {
  assertStorageStateEncryptionReady,
  loadStoredStorageState,
  saveStoredStorageState,
} from "./security/storage-state.js";

const execFileAsync = promisify(execFile);

const CAMOUFOX_OPTIONS_SCRIPT = String.raw`
import json
import os
import sys

try:
    from camoufox.utils import launch_options
except Exception as exc:
    print(f"CAMOUFOX_IMPORT_ERROR::{exc}", file=sys.stderr)
    raise

payload = json.loads(os.environ["ONEGL_CAMOUFOX_PAYLOAD"])
options = launch_options(**payload)
print(json.dumps(options))
`;

async function camoufoxLaunchOptions(config, forceHeadful) {
  // Deliberately do not request Camoufox's behavior-humanization options. OneGl's
  // operational safety comes from low volume, explicit backoff and manual handling of
  // verification/access restrictions, not from trying to disguise automated behavior.
  const payload = {
    headless: forceHeadful ? false : config.headless,
  };

  try {
    const { stdout } = await execFileAsync(
      config.camoufoxPython,
      ["-c", CAMOUFOX_OPTIONS_SCRIPT],
      {
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          ...process.env,
          ONEGL_CAMOUFOX_PAYLOAD: JSON.stringify(payload),
        },
      },
    );
    return JSON.parse(stdout.trim());
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String(error.stderr || "")
        : "";
    const installHint =
      "Install Camoufox first: python3 -m pip install 'cloverlabs-camoufox[geoip]' && python3 -m camoufox set official/stable && python3 -m camoufox fetch";
    throw new DoubaoMvpError(
      ErrorCode.UNKNOWN_ERROR,
      `${stderr || (error instanceof Error ? error.message : String(error))}. ${installHint}`,
      { stage: "camoufox_launch_options" },
      { cause: error },
    );
  }
}

export async function launchBrowserSession(
  config,
  { forceHeadful = false, ignoreStoredAuth = false } = {},
) {
  let browser;
  const headless = forceHeadful ? false : config.headless;
  // Validate the encryption contract even for a fresh remote-auth session. Otherwise a browser
  // could accept a login and only discover at save time that the required key is absent/invalid.
  assertStorageStateEncryptionReady(config);
  // Resolve/decrypt authentication before launching a browser. If the key is missing or wrong,
  // fail closed without creating a provider session that cannot safely persist its next state.
  const storedAuth = ignoreStoredAuth
    ? { present: false, encrypted: false, migrated: false, state: null, path: null }
    : await loadStoredStorageState(config);

  if (config.browser === "camoufox") {
    const options = await camoufoxLaunchOptions(config, forceHeadful);
    // Camoufox's Python launcher returns snake_case keys, but Playwright's Node API
    // expects camelCase ones. Passing the raw object makes Playwright ignore the
    // Camoufox executable path and fail with "Executable doesn't exist".
    browser = await firefox.launch({
      executablePath: options.executable_path,
      args: options.args,
      env: options.env,
      firefoxUserPrefs: options.firefox_user_prefs,
      headless: options.headless ?? headless,
    });
  } else {
    const launcher = config.browser === "chromium" ? chromium : firefox;
    browser = await launcher.launch({
      headless,
      executablePath: config.browserExecutable || undefined,
    });
  }

  const context = await browser.newContext({
    storageState: storedAuth.present ? storedAuth.state : undefined,
    // Identical on every cold start, per account. Without this a restarted Worker
    // presents a different locale/timezone/window than the session it is resuming.
    locale: config.locale,
    timezoneId: config.timezoneId,
    viewport: { width: config.viewportWidth, height: config.viewportHeight },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.setDefaultNavigationTimeout(60_000);

  return {
    browser,
    context,
    page,
    hasStoredAuth: storedAuth.present,
    storageStateEncrypted: storedAuth.encrypted,
    storageStateMigrated: storedAuth.migrated,
    storageStatePath: storedAuth.path,
    /**
     * A crashed/disconnected session is indistinguishable from a risk signal when the
     * only symptom is a timeout: every subsequent job then fails against a dead
     * browser and the operator sees a stream of odd errors. Rebuilding the browser is
     * cheap; reusing a corpse is not.
     */
    isHealthy() {
      try {
        return (
          browser.isConnected() &&
          context.pages().length > 0 &&
          !page.isClosed()
        );
      } catch {
        return false;
      }
    },
    async saveAuth() {
      const state = await context.storageState();
      return saveStoredStorageState(config, state);
    },
    async close() {
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    },
  };
}
