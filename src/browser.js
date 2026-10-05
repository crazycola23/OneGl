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
#
# 2026-10-05 实测：这里原本按 viewport 钉成 Screen(min=max=viewport)，**约束从未生效**。
# 现象是每次启动的 screen 在 1440x900 / 1600x900 / 1920x1080 / 2560x1440 / 3072x1728 /
# 5120x1440 之间跳，而 UA 与 navigator.platform 恒为 Win32 —— 其中 3072x1728 是
# MacBook Pro 的 retina 逻辑分辨率，于是形成了「自称 Windows 却报 Mac 屏幕」的
# 自相矛盾指纹，正是这类内部不一致会被平台风控单独盯上。
#
# 根因（browserforge generator.py:204-220）：UA 是**先**随机抽出来的，之后才去问
# 「有没有同时满足 UA 与 screen 约束的解」。约束一旦与已抽中的 UA 无解，
# generator 在 strict 为假时静默执行 filtered_values = {}（把 screen 约束整个丢掉），
# 重新采样一个不受约束的指纹 —— 不报错、不告警。所以 pin 写了等于没写。
#
# 两条修法都实测过（每次 5 轮，看 CAMOU_CONFIG_1 里实际落库的 screen）：
#   - Screen(min=max=viewport 1440x900)      -> 5/5 越界
#   - Screen(min=max=1920x1080)              -> 5/5 精确命中
# viewport 尺寸（1440x900）在采样库里对应 361 条候选，但它们几乎全带
# devicePixelRatio=2 / colorDepth=30|32，与 Windows+Firefox 的其余字段无法共存，
# 于是每次都走「无解 -> 丢约束」分支。1920x1080 则是采样库里的主流桌面组合。
#
# 因此这里钉的是「与声明 OS 相符的常见桌面分辨率」，而不是「与 viewport 相等的尺寸」。
# 两者的区别不是美观问题：前者让屏幕与 UA/platform/WebGL 互相自洽，后者做不到。
# 具体尺寸取自 config 的 camoufoxScreenWidth/Height（默认 1920x1080），可由
# ONEGL_CAMOUFOX_SCREEN_WIDTH/HEIGHT 覆盖，**不再与 viewport 复用同一个值**。
screen_size = payload.pop("screen_size", None)
if screen_size:
    width = int(screen_size["width"])
    height = int(screen_size["height"])
    # 约束失效是 browserforge 的静默降级（不抛异常），所以必须在生成后复核，
    # 否则「pin 了但没生效」在运行日志里完全不可见 —— 前三轮指纹审计就漏在这里。
    payload["screen"] = Screen(
        min_width=width,
        max_width=width,
        min_height=height,
        max_height=height,
    )
    payload["_screen_guard"] = {"width": width, "height": height}

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

# launch_options 内部 sample_webgl 会随机抽 vendor/renderer 组合，而本地采样库
# 并非覆盖所有组合 —— 偶发抛 "No WebGL data found"。实测 8 次里 0 次、另一次 1 次
# 命中，属随机波动而非确定性失败。重试若干次再放弃，避免一次偶发拖垮整轮采集。
# 每次重试都会重新随机种子，所以重试不会退化成「同一个指纹」。
#
# 2026-10-05 追加：screen 约束在同一循环里复核。约束失效是 browserforge 的静默
# 降级（generator.py:216 的 filtered_values = {}），不抛异常，只能拿结果反查。
# 不复核的后果是「pin 了但没生效」这种故障在运行日志里完全不可见 —— 前三轮
# 指纹审计就是漏在这里。
import time as _time

_screen_guard = payload.pop("_screen_guard", None)
_last_error = None
_succeeded = False
for _attempt in range(6):
    try:
        options = launch_options(**payload)
        _last_error = None
        _succeeded = True
        break
    except ValueError as _exc:
        if "No WebGL data found" not in str(_exc):
            raise
        _last_error = _exc
        _time.sleep(0.2)

if not _succeeded:
    raise RuntimeError(
        "Camoufox could not pick a usable WebGL fingerprint after 6 attempts: "
        f"{_last_error}"
    )

if _screen_guard is not None:
    _got = json.loads(options["env"]["CAMOU_CONFIG_1"])
    _w = _got.get("screen.width")
    _h = _got.get("screen.height")
    if _w != _screen_guard["width"] or _h != _screen_guard["height"]:
        raise RuntimeError(
            "Camoufox could not honour the pinned screen constraint: requested "
            f"{_screen_guard['width']}x{_screen_guard['height']}, generated {_w}x{_h}. "
            "browserforge silently drops unsatisfiable screen constraints, so this must "
            "fail loudly instead of launching a self-contradictory fingerprint."
        )

# 2026-10-05 实测记录（这里曾经有一段错误的「修复」，已按A/B 对照结果移除）：
#
# 当时的判断是「canvas 指纹没换」，理由是 _build_init_script() 按驼峰键名
# （canvasSeed）找值，而 CAMOU_CONFIG_1 里存的是冒号键名（canvas:seed），
# 于是编译出的 init script 只有 104 字节、噪声 setter 一个都没进去。
#
# 那个判断是错的。做法：把冒号键名映射成驼峰、用 Playwright 的
# context.addInitScript() 注入重新编译的 init script。随后做 A/B 对照 ——
# 把这段完整移除后重跑 4 轮，页面侧 canvasHash 仍然 4/4 在变，与「修复」后
# 逐项相同。也就是说这段代码从未影响过任何页面读数。
#
# 真正生效的路径是 CAMOU_CONFIG_1 环境变量：Camoufox 把整份配置交给浏览器内部
# 的 C++ 层直接消费（utils.py:96 把配置切成 CAMOU_CONFIG_N 环境变量）。
# _build_init_script() 是「不经该环境变量、直接用 Playwright 开 camoufox」时的
# 备用路径，我们不走它 —— 所以键名对不上在这里不构成 bug。
#
# 保留 onegl_fingerprint_config 回传：它是审计工具做「配置 vs 页面」双向对照
# 的唯一可靠数据源（走 /proc 读子进程 environ 会因权限失败：worker 以 onegl
# 用户运行读不到，而用 root 起浏览器会被 Camoufox 拒绝）。
cfg = json.loads(options["env"]["CAMOU_CONFIG_1"])
options["onegl_fingerprint_config"] = cfg
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
 *
 * The claimed screen is deliberately **not** the viewport. A screen constraint only takes
 * effect if it is satisfiable together with the user agent browserforge sampled first, and
 * an unsatisfiable one is dropped silently: pinning the screen to the 1440x900 viewport hit
 * that constraint 12/40 times and otherwise reported 3072x1728 - a MacBook Pro resolution -
 * under a Win32 user agent. `camoufoxScreenWidth/Height` defaults to 1920x1080, which landed
 * 5/5 across repeated launches.
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

  // The claimed screen is not the viewport. browserforge can only satisfy a screen
  // constraint that is consistent with the user agent it sampled, and it drops the
  // constraint silently when it is not — measured hit rate for the viewport size was
  // 12/40, while 1920x1080 landed 5/5. Defaults come from config so an operator can
  // move to another mainstream resolution without touching this file.
  const screenWidth = Number(config.camoufoxScreenWidth);
  const screenHeight = Number(config.camoufoxScreenHeight);
  if (!Number.isInteger(screenWidth) || screenWidth < 1 || !Number.isInteger(screenHeight) || screenHeight < 1) {
    throw new DoubaoMvpError(
      ErrorCode.UNKNOWN_ERROR,
      `Camoufox screen must be a positive integer size (got ${JSON.stringify([screenWidth, screenHeight])}).`,
      { stage: "camoufox_launch_options" },
    );
  }
  // The window cannot be larger than the screen it claims, or the geometry is
  // self-contradictory in a different way (outerWidth > screen.width).
  if (screenWidth < width || screenHeight < height) {
    throw new DoubaoMvpError(
      ErrorCode.UNKNOWN_ERROR,
      `Camoufox screen ${screenWidth}x${screenHeight} is smaller than the window ${width}x${height}.`,
      { stage: "camoufox_launch_options" },
    );
  }

  return {
    headless: resolvedMode === "headless",
    os: config.camoufoxOs,
    locale: config.locale,
    window: [width, height],
    screen_size: { width: screenWidth, height: screenHeight },
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

  // Xvfb 屏尺寸：2026-10-05 实测（四档对比，见 .ops/compare-xvfb-screens.mjs）
  //
  // 原值是 "1x1x24"，照抄自 Camoufox 的默认值，代价是**页面静止时合成器不出帧**：
  //   1x1x24        静置 2s 推进 1 帧 → Playwright click() 的 stable 判定用 rAF 轮询
  //                              → 永远过不去 → 死等到超时
  //   1440x900x24   静置 2s 推进 119 帧 → click 237ms 成功
  //   1920x1080x24  55 帧 → click 258ms
  //   2560x1440x24  17 帧 → click 406ms
  //
  // 这就是 tryClickSend 恒返回 false、全部落进 Enter 回退的直接原因：不是选择器不对，
  // 是那一道 stable 校验永远不 resolve。1×1 屏下整套 UI 交互都不可用。
  //
  // 取 1440×900 的理由（全部实测，非推断）：
  //   - rAF 帧数最高、click 最快；
  //   - 与 config.js 的 viewport 默认值同源，窗口恰好铺满声称的屏幕，几何关系自洽；
  //   - **不改变页面侧读数**：四档实测下 screen/outer/inner/colorDepth 与几何自洽判据
  //     全部一致（声明的 screen 仍由 camoufoxScreenWidth/Height 钉在 1920×1080，
  //     由 CAMOUFOX_OPTIONS_SCRIPT 里的 _screen_guard 复核），所以它修的是交互，
  //     不碰指纹。1×1 屏曾被怀疑「让 Camoufox 采样塌陷」，实测否掉了：核数与字体数
  //     在四档之间随机波动（8/16/32、63–86），与屏尺寸无因果关系。
  //
  // 保留环境变量覆盖，便于回到旧值对照。
  const virtualScreenSize = process.env.CAMOUFOX_VIRTUAL_DISPLAY_SIZE || "1440x900x24";

  // Mirror Camoufox's virtual-display defaults, but keep Xvfb owned by the Node
  // browser session. Xvfb chooses a free display atomically via -displayfd.
  const args = [
    "-displayfd", "3",
    "-screen", "0", virtualScreenSize,
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
  // 本次启动注入的指纹原样保留，供审计工具核对「配置 vs 页面」。
  let camoufoxFingerprintConfig = null;
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
      camoufoxFingerprintConfig = options.onegl_fingerprint_config ?? null;
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

    // 这里曾经挂过 context.addInitScript(camoufoxInitScript)，试图补上 Camoufox 的
    // canvas/audio/font 噪声注入。A/B 对照证明它对页面读数零影响（移除前后
    // canvasHash 都是 4/4 在变），故已移除。噪声实际由 CAMOU_CONFIG_1 环境变量
    // 交给浏览器内部 C++ 层完成，详见 CAMOUFOX_OPTIONS_SCRIPT 里的实测记录。

    const session = {
      browser,
      /** 本次启动注入的指纹配置（CAMOU_CONFIG_1），供审计工具核对。 */
      camoufoxFingerprintConfig,
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

