import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { readdir, readFile, rm } from "node:fs/promises";
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
    from camoufox.addons import DefaultAddons
    from browserforge.fingerprints import Screen
except Exception as exc:
    print(f"CAMOUFOX_IMPORT_ERROR::{exc}", file=sys.stderr)
    raise

payload = json.loads(os.environ["ONEGL_CAMOUFOX_PAYLOAD"])

# launch_options() takes a Screen object, not a dict, and Camoufox otherwise derives the
# screen from the physical monitor. Under the virtual Xvfb display that monitor is 1x1, so
# the reported screen contradicted the viewport Playwright pins on the context.
screen_size = payload.pop("screen_size", None)
if screen_size:
    width = int(screen_size["width"])
    height = int(screen_size["height"])
    payload["screen"] = Screen(
        min_width=width,
        max_width=width,
        min_height=height,
        max_height=height,
    )

# Camoufox otherwise downloads its default uBlock add-on on the first launch.
# Production containers must not depend on runtime access to AMO (and a failed
# download can leave an empty cache directory that fails every later launch with
# InvalidAddonPath). The image build bundles a pinned, verified uBlock build;
# load that extracted directory explicitly and keep the default auto-download
# disabled.
#
# Two shapes have to work with the same code. In the image the bundle is the only
# permitted source, so a missing manifest is a hard failure - that check is what stops a
# broken build from reaching production. On a local Windows checkout the bundle path does
# not exist at all, and failing there would mean the browser cannot be launched for any
# local verification. So: an explicitly configured path stays strict on every platform;
# the image default fails closed on Linux; Windows falls back to "no add-ons" instead.
payload["exclude_addons"] = list(DefaultAddons)
ublock_path = os.environ.get("ONEGL_CAMOUFOX_UBLOCK_PATH", "/opt/onegl-addons/ublock").strip()
manifest_path = os.path.join(ublock_path, "manifest.json")
ublock_explicit = "ONEGL_CAMOUFOX_UBLOCK_PATH" in os.environ
ublock_bundled = os.path.isdir(ublock_path) and os.path.isfile(manifest_path)
if ublock_bundled:
    payload["addons"] = [ublock_path]
elif ublock_explicit or sys.platform.startswith("linux"):
    raise RuntimeError(
        f"Bundled uBlock add-on is missing or invalid: {ublock_path} (manifest.json required)"
    )
else:
    print(f"CAMOUFOX_UBLOCK_UNAVAILABLE::{ublock_path}", file=sys.stderr)

options = launch_options(**payload)
print(json.dumps(options))
`;

/**
 * The JSON handed to Camoufox's `launch_options()`.
 *
 * `os`, `locale` and the screen/window geometry are pinned on purpose. Camoufox otherwise
 * picks a random OS (and therefore UA, font metrics and WebGL vendor) on every launch, while
 * the Playwright context below pins locale, timezone and viewport - so a restarted worker
 * could present a macOS user agent over Linux font metrics, on a zh-CN/Shanghai context.
 * Fingerprint noise seeds (canvas/audio/font spacing) still rotate per launch; that is
 * Camoufox's own default and is not device identity.
 */
export function camoufoxLaunchPayload(
  config,
  { mode = null, virtualDisplay = null } = {},
) {
  const width = Number(config.viewportWidth);
  const height = Number(config.viewportHeight);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new DoubaoMvpError(
      ErrorCode.UNKNOWN_ERROR,
      `Camoufox screen must be a positive integer size (got ${JSON.stringify([width, height])}).`,
      { stage: "camoufox_launch_options" },
    );
  }
  const resolvedMode = mode ?? resolveCamoufoxMode(config);

  return {
    headless: resolvedMode === "headless",
    os: config.camoufoxOs,
    locale: config.locale,
    window: [width, height],
    screen_size: { width, height },
    ...(virtualDisplay ? { virtual_display: virtualDisplay } : {}),
  };
}

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

// ---------------------------------------------------------------------------
// Camoufox orphan reaping
//
// Playwright owns only the launcher process it spawned. In the camoufox + Xvfb
// ("virtual") topology the browser forks a tree of helper processes
// (`-contentproc ... tab|rdd|utility|socket`) that Playwright never tracks.
// `browser.close()` merely *asks* the main process to quit; when any helper
// refuses to exit the tree survives as orphans, eating a session slot in the
// single-threaded auth-session broker and eventually stalling every later
// login behind a queue that never drains.
//
// Playwright gives each launch a unique temporary profile directory named
// `playwright_firefoxdev_profile-XXXXXX`, and camoufox passes it to every
// process in the tree via `-profile <path>`. That name is therefore a stable,
// collision-free handle for the whole tree, and it is available without
// relying on Playwright internals.
// ---------------------------------------------------------------------------

const PROFILE_DIR_PREFIX = "playwright_firefoxdev_profile-";
// Playwright puts its per-launch profile in the platform temp dir, which is TMPDIR on Linux
// containers and TEMP/TMP on Windows. Hardcoding /tmp meant the Windows path never resolved,
// so every launch leaked a full browser profile into %TEMP% - invisible while one browser
// served a whole session, gigabytes once the session is rebuilt on a rotation counter.
//
// 用 `process.env.TMPDIR` 而不是 `os.tmpdir()`、用字符串拼接而不是 `path.join()`：这个模块
// 的孤儿进程回收逻辑是被 test/browser-orphan-reaping.test.mjs 用 extractFunction 逐个函数
// 抽出来、放进 vm 沙箱里跑的（见该测试的 buildHarness）。沙箱只注入 readdir/readFile/rm
// 这几个绑定和一份 `process` 替身，没有注入 os/path —— 依赖 `os` 或 `path` 会让那些用例
// 在沙箱里直接 ReferenceError。同理，取临时目录的表达式必须内联在函数体里：抽函数是按
// 单个 function 声明做的，额外定义一个模块级 helper 不会被一起带进沙箱。
//
// 语义上是等价的：Node 的 os.tmpdir() 在 Linux 上读的就是 TMPDIR，Windows 上读 TEMP/TMP。
// 拼接统一用 POSIX 分隔符，因为真正读这个路径的 /proc 反查只在 Linux 上跑。
async function listProfileDirs() {
  const root = process.env.TMPDIR || "/tmp";
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return new Set(
      entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(PROFILE_DIR_PREFIX))
        .map((entry) => `${root}/${entry.name}`),
    );
  } catch {
    return new Set();
  }
}

/**
 * Linux 下按 profile 路径反查进程 PID。
 * 读 /proc/<pid>/cmdline 而非 `ps`：容器镜像里不一定装了 procps，/proc 则始终可用。
 */
async function findPidsByProfile(profilePath) {
  if (process.platform !== "linux" || !profilePath) return [];
  let pids = [];
  try {
    pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
  } catch {
    return [];
  }
  const matched = [];
  await Promise.all(
    pids.map(async (pid) => {
      try {
        const raw = await readFile(`/proc/${pid}/cmdline`, "utf8");
        // cmdline 以 NUL 分隔，直接 includes 即可命中 "-profile <path>"
        if (raw.includes(profilePath)) matched.push(Number(pid));
      } catch {
        // 进程已退出 / 权限不足 —— 忽略
      }
    }),
  );
  return matched;
}

/**
 * 强制回收某个 camoufox profile 对应的整个进程树。
 * 返回 { found, killed }，供调用方记录（失败不抛，避免影响主流程收尾）。
 */
async function reapBrowserTree(profilePath, { graceMs = 3_000 } = {}) {
  const found = await findPidsByProfile(profilePath);
  if (found.length === 0) return { found: 0, killed: 0 };

  // 先 SIGTERM 让主进程有机会带子进程优雅退出
  for (const pid of found) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* 已退出 */
    }
  }
  await sleep(graceMs);

  const survivors = await findPidsByProfile(profilePath);
  for (const pid of survivors) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 已退出 */
    }
  }
  if (survivors.length > 0) await sleep(500);

  return { found: found.length, killed: survivors.length };
}

async function removeProfileDir(profilePath) {
  if (!profilePath) return;
  try {
    await rm(profilePath, { recursive: true, force: true });
  } catch {
    /* 目录可能已被 Playwright 清理 */
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
  const payload = camoufoxLaunchPayload(config, { mode, virtualDisplay });

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

function contextOptionsFrom(config, storedAuth) {
  return {
    storageState: storedAuth?.present ? storedAuth.state : undefined,
    // Identical on every cold start, per account. Without this a restarted Worker
    // presents a different locale/timezone/window than the session it is resuming.
    locale: config.locale,
    timezoneId: config.timezoneId,
    viewport: { width: config.viewportWidth, height: config.viewportHeight },
  };
}

export async function launchBrowserSession(
  config,
  { forceHeadful = false, ignoreStoredAuth = false } = {},
) {
  let browser;
  let virtualDisplay;
  let profilesBefore = new Set();
  let profilesAfter = new Set();
  let profilePath = null;
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
      // 记录启动前的 profile 目录集合，启动后 diff 出本次会话专属的那个。
      // 这是回收整棵 camoufox 进程树（含 Playwright 不管理的 contentproc）的唯一钥匙。
      profilesBefore = await listProfileDirs();
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
      profilesAfter = await listProfileDirs();
      profilePath =
        [...profilesAfter].find((dir) => !profilesBefore.has(dir)) ?? null;
    } else {
      const launcher = config.browser === "chromium" ? chromium : firefox;
      browser = await launcher.launch({
        headless,
        executablePath: config.browserExecutable || undefined,
      });
    }

    let context = await browser.newContext(contextOptionsFrom(config, storedAuth));
    let page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(60_000);

    const session = {
      browser,
      // Getters, not snapshots: rotateContext() replaces both objects and every caller must
      // see the live page rather than the one it captured at launch.
      get context() {
        return context;
      },
      get page() {
        return page;
      },
      /** Prompts served by the current context; the worker rotates the window on this count. */
      contextPrompts: 0,
      /**
       * The Playwright temp profile this launch owns, or null when it could not be identified.
       *
       * Exposed rather than kept local because it is the only handle on the browser's process
       * tree: if it is null the tree cannot be reaped and the profile cannot be removed, and
       * that failure is otherwise invisible until /tmp or %TEMP% is full.
       */
      profilePath,
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
      /**
       * Throw away conversation state and open a clean window, keeping the browser process.
       *
       * What this resets is the chat surface: history, localStorage, IndexedDB and the
       * in-memory page. What it deliberately does not reset is device identity - Camoufox
       * fixes the fingerprint at launch, so the platform still sees the same machine
       * returning, which is what an account session should look like. Rotating by relaunch
       * would also churn the camoufox process tree, and an un-reaped tree holds an auth
       * session slot open (see the orphan-reaping note above).
       */
      async rotateContext() {
        // Carry renewed cookies forward; everything else about the round is discarded.
        const carried = await context.storageState().catch(() => storedAuth.state);
        await context.close().catch(() => undefined);
        context = await browser.newContext(
          contextOptionsFrom(config, { present: Boolean(carried), state: carried }),
        );
        page = await context.newPage();
        page.setDefaultTimeout(15_000);
        page.setDefaultNavigationTimeout(60_000);
        session.contextPrompts = 0;
        return page;
      },
      async close() {
        await context.close().catch(() => undefined);
        await browser.close().catch(() => undefined);
        // Playwright 只保证自己 spawn 的 launcher 退出；camoufox 的 contentproc 树不在其管辖内。
        // 若整棵树没退干净，按 profile 反查并强杀，否则会话槽位会被孤儿进程长期占住。
        if (profilePath) {
          const reaped = await reapBrowserTree(profilePath).catch(() => null);
          if (reaped && reaped.found > 0) {
            process.emitWarning?.(
              `camoufox tree still alive after browser.close(); reaped ${reaped.found} process(es)`,
            );
          }
          await removeProfileDir(profilePath);
        }
        await virtualDisplay?.close().catch(() => undefined);
      },
    };
    return session;
  } catch (error) {
    await browser?.close().catch(() => undefined);
    if (profilePath) {
      await reapBrowserTree(profilePath).catch(() => undefined);
      await removeProfileDir(profilePath);
    }
    await virtualDisplay?.close().catch(() => undefined);
    throw error;
  }
}

