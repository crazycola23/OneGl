import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
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

export function resolveCamoufoxMode(config, { forceHeadful = false } = {}) {
  if (forceHeadful) return "headful";
  const mode = config.camoufoxMode ?? (config.headless ? "headless" : "headful");
  if (!new Set(["virtual", "headless", "headful"]).has(mode)) {
    throw new Error(`Unsupported Camoufox mode: ${mode}`);
  }
  return mode;
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function stopVirtualDisplay(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit").catch(() => undefined), sleep(1_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([once(child, "exit").catch(() => undefined), sleep(1_000)]);
  }
}

async function startVirtualDisplay() {
  if (process.platform !== "linux") {
    throw new DoubaoMvpError(
      ErrorCode.UNKNOWN_ERROR,
      "ONEGL_CAMOUFOX_MODE=virtual is only supported on Linux.",
      { stage: "camoufox_virtual_display" },
    );
  }

  // Mirror Camoufox's virtual-display defaults, but keep Xvfb owned by the Node
  // browser session. Xvfb chooses a free display atomically via -displayfd.
  const args = [
    "-displayfd", "3",
    "-screen", "0", process.env.CAMOUFOX_VIRTUAL_DISPLAY_SIZE || "1x1x24",
    "-ac",
    "-nolisten", "tcp",
    "-extension", "RENDER",
    "+extension", "GLX",
    "-extension", "COMPOSITE",
    "-extension", "XVideo",
    "-extension", "XVideo-MotionCompensation",
    "-extension", "XINERAMA",
    "-fp", "built-ins",
    "-nocursor",
    "-br",
  ];
  const child = spawn("Xvfb", args, {
    stdio: ["ignore", "ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      __GLX_VENDOR_LIBRARY_NAME: "mesa",
      LIBGL_ALWAYS_SOFTWARE: "1",
    },
  });
  const displayFd = child.stdio[3];
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    if (stderr.length < 8_192) stderr += String(chunk);
  });

  try {
    const displayNumber = await new Promise((resolve, reject) => {
      let buffer = "";
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("error", onError);
        child.off("exit", onExit);
        displayFd?.off("data", onData);
        if (error) reject(error);
        else resolve(value);
      };
      const onError = (error) => finish(error);
      const onExit = (code, signal) => finish(
        new Error(`Xvfb exited before reporting a display (code=${code}, signal=${signal}, stderr=${stderr.trim()})`),
      );
      const onData = (chunk) => {
        buffer += String(chunk);
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const raw = buffer.slice(0, newline).trim();
        if (!/^\d+$/.test(raw)) {
          finish(new Error(`Xvfb returned an invalid display number: ${JSON.stringify(raw)}`));
          return;
        }
        finish(null, Number(raw));
      };
      const timer = setTimeout(
        () => finish(new Error(`Xvfb did not report a display within 10000ms (stderr=${stderr.trim()})`)),
        10_000,
      );
      timer.unref?.();
      child.once("error", onError);
      child.once("exit", onExit);
      displayFd?.on("data", onData);
      if (!displayFd) finish(new Error("Xvfb displayfd pipe is unavailable"));
    });

    return {
      display: `:${displayNumber}`,
      async close() {
        await stopVirtualDisplay(child);
      },
    };
  } catch (error) {
    await stopVirtualDisplay(child);
    const installHint = "Install Xvfb (for example: apt-get install xvfb) or choose ONEGL_CAMOUFOX_MODE=headless.";
    throw new DoubaoMvpError(
      ErrorCode.UNKNOWN_ERROR,
      `${error instanceof Error ? error.message : String(error)}. ${installHint}`,
      { stage: "camoufox_virtual_display" },
      { cause: error },
    );
  }
}

async function camoufoxLaunchOptions(config, { mode, virtualDisplay = null } = {}) {
  // Do not request Camoufox behavior-humanization. OneGl's operational safety
  // comes from conservative rate limits, explicit backoff and manual handling
  // of verification/access restrictions.
  const payload = {
    headless: mode === "headless",
    ...(virtualDisplay ? { virtual_display: virtualDisplay } : {}),
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
  let virtualDisplay;
  const headless = forceHeadful ? false : config.headless;
  // Validate the encryption contract even for a fresh remote-auth session. Otherwise a browser
  // could accept a login and only discover at save time that the required key is absent/invalid.
  assertStorageStateEncryptionReady(config);
  // Resolve/decrypt authentication before launching a browser. If the key is missing or wrong,
  // fail closed without creating a provider session that cannot safely persist its next state.
  const storedAuth = ignoreStoredAuth
    ? { present: false, encrypted: false, migrated: false, state: null, path: null }
    : await loadStoredStorageState(config);

  try {
    if (config.browser === "camoufox") {
      const mode = resolveCamoufoxMode(config, { forceHeadful });
      if (mode === "virtual") virtualDisplay = await startVirtualDisplay();
      const options = await camoufoxLaunchOptions(config, {
        mode,
        virtualDisplay: virtualDisplay?.display ?? null,
      });
      // Camoufox's Python launcher returns snake_case keys, but Playwright's Node API
      // expects camelCase ones. Passing the raw object makes Playwright ignore the
      // Camoufox executable path and fail with "Executable doesn't exist".
      browser = await firefox.launch({
        executablePath: options.executable_path,
        args: options.args,
        env: options.env,
        firefoxUserPrefs: options.firefox_user_prefs,
        headless: options.headless ?? (mode === "headless"),
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
        await virtualDisplay?.close().catch(() => undefined);
      },
    };
  } catch (error) {
    await browser?.close().catch(() => undefined);
    await virtualDisplay?.close().catch(() => undefined);
    throw error;
  }
}

