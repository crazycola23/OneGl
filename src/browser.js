import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { chromium, firefox } from "playwright-core";
import { DoubaoMvpError, ErrorCode } from "./errors.js";

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

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function camoufoxLaunchOptions(config, forceHeadful) {
  const payload = {
    headless: forceHeadful ? false : config.headless,
    humanize: 1.5,
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

  if (config.browser === "camoufox") {
    const options = await camoufoxLaunchOptions(config, forceHeadful);
    browser = await firefox.launch(options);
  } else {
    const launcher = config.browser === "chromium" ? chromium : firefox;
    browser = await launcher.launch({
      headless,
      executablePath: config.browserExecutable || undefined,
    });
  }

  const hasStoredAuth = !ignoreStoredAuth && (await exists(config.authStatePath));
  const context = await browser.newContext({
    storageState: hasStoredAuth ? config.authStatePath : undefined,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.setDefaultNavigationTimeout(60_000);

  return {
    browser,
    context,
    page,
    hasStoredAuth,
    async saveAuth() {
      await mkdir(dirname(config.authStatePath), { recursive: true });
      await context.storageState({ path: config.authStatePath });
    },
    async close() {
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    },
  };
}
