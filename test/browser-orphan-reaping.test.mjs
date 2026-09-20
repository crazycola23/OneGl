/**
 * Camoufox 孤儿进程回收回归测试（2026-09-20）。
 *
 * 背景：GEO 端扫码登录长时间卡在 `pending`。排查到第三层根因 ——
 * `launchBrowserSession` 关闭时只调 `browser.close()`，而 Playwright 只保证自己
 * spawn 的 launcher 退出；camoufox 在 Xvfb 虚拟显示下 fork 出的
 * `-contentproc ... tab|rdd|utility|socket` 进程树不在其管辖内。这些孤儿进程
 * 长期占住 GEO 侧 `Executors.newSingleThreadExecutor` 的会话槽位
 * （线上实测容器内残留 28 个进程，且 /tmp 里堆了 3 个已废弃的
 * `playwright_firefoxdev_profile-*` 目录），导致后续登录排队永远不推进。
 *
 * 修法（src/browser.js）：启动前后 diff `playwright_firefoxdev_profile-*` 目录集合，
 * 得到本次会话专属的 profile 路径；关闭时按该路径从 /proc 反查进程并强制回收，
 * 最后清理 profile 目录。
 *
 * 本文件用真实子进程验证行为，而不是只做源码静态断言 —— 静态断言无法证明
 * 「进程真的被杀死了」。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "..", "src", "browser.js"), "utf8");

function extractFunction(name) {
  const needle = `async function ${name}(`;
  const start = source.indexOf(needle);
  assert.ok(start >= 0, `源码中找不到 ${name}`);
  // 先配平参数列表的圆括号 —— 形如 `{ graceMs = 3_000 } = {}` 的默认值里含有花括号，
  // 若直接从第一个 `{` 开始数花括号深度，会在签名内部被误判为函数体结束。
  let paren = source.indexOf("(", start);
  let parenDepth = 0;
  for (; paren < source.length; paren += 1) {
    if (source[paren] === "(") parenDepth += 1;
    else if (source[paren] === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) break;
    }
  }
  let depth = 0;
  let index = source.indexOf("{", paren);
  for (; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return source.slice(start, index + 1);
}

const isLinux = process.platform === "linux";

/**
 * 在 vm 上下文里装配这几个函数，并把 TMPDIR 指到测试专属目录，
 * 这样 listProfileDirs 只看到我们摆好的假 profile。
 */
function buildHarness(tmpRoot) {
  const context = {
    process: {
      platform: process.platform,
      env: { TMPDIR: tmpRoot },
      kill: (...args) => process.kill(...args),
      emitWarning: () => undefined,
    },
    // 源码改为静态导入 fs/promises 后，沙箱需要提供同名绑定。
    readdir,
    readFile,
    rm,
    // reapBrowserTree 依赖模块级 sleep（生产实现带 unref）。测试沙箱里刻意不 unref：
    // unref 过的 timer 不会撑住事件循环，node:test 会在 Promise 未落地时报
    // "event loop has already resolved" 并把用例判为 cancelledByParent。
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    console,
    setTimeout,
    clearTimeout,
    Promise,
  };
  vm.createContext(context);
  vm.runInContext(
    [
      `const PROFILE_DIR_PREFIX = "playwright_firefoxdev_profile-";`,
      `const PROFILE_TMP_DIR = process.env.TMPDIR || "/tmp";`,
      extractFunction("listProfileDirs"),
      extractFunction("findPidsByProfile"),
      extractFunction("reapBrowserTree"),
      extractFunction("removeProfileDir"),
    ].join("\n"),
    context,
  );
  return context;
}

/** 启动一个「冒充 camoufox」的常驻进程，命令行里带上 -profile <dir>。 */
function spawnFakeBrowser(profileDir) {
  // 注意：node 把以 `-` 开头的额外参数当自己的选项解析，`-profile` 会直接导致
  // 进程报错退出。因此先放 `--` 终止选项解析，再传 `-profile <dir>` ——
  // 这样 cmdline 里仍然完整保留 camoufox 风格的 `-profile <path>`，
  // 与真实 camoufox 命令行形态一致。
  return spawn(
    process.execPath,
    [
      "-e",
      // 长驻，等待被外部信号杀掉
      "setInterval(() => {}, 1000);",
      "--",
      "-profile",
      profileDir,
    ],
    { stdio: "ignore", detached: false },
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("listProfileDirs 只识别 camoufox 的 profile 目录", async (t) => {
  if (!isLinux) return t.skip("仅在 Linux 上验证（/proc 与 TMPDIR 语义）");
  const root = mkdtempSync(path.join(tmpdir(), "onegl-profiles-"));
  try {
    await mkdir(path.join(root, "playwright_firefoxdev_profile-AAA111"), { recursive: true });
    await mkdir(path.join(root, "playwright_firefoxdev_profile-BBB222"), { recursive: true });
    await mkdir(path.join(root, "unrelated-dir"), { recursive: true });
    await writeFile(path.join(root, "playwright_firefoxdev_profile-FILE"), "not a dir");

    const ctx = buildHarness(root);
    const dirs = await ctx.listProfileDirs();
    assert.deepEqual(
      [...dirs].sort(),
      [
        `${root}/playwright_firefoxdev_profile-AAA111`,
        `${root}/playwright_firefoxdev_profile-BBB222`,
      ],
      "只应返回 profile 目录，忽略同名文件与无关目录",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reapBrowserTree 杀掉整棵进程树并清理 profile 目录", async (t) => {
  if (!isLinux) return t.skip("仅在 Linux 上验证（依赖 /proc 反查）");
  const root = mkdtempSync(path.join(tmpdir(), "onegl-reap-"));
  const profileDir = path.join(root, "playwright_firefoxdev_profile-REAP01");
  await mkdir(profileDir, { recursive: true });

  const parent = spawnFakeBrowser(profileDir);
  // 再起一个「子进程」也带同一 profile（模拟 camoufox 的 contentproc 树）
  const child = spawnFakeBrowser(profileDir);
  try {
    await sleep(600);
    const ctx = buildHarness(root);

    const viaProc = await ctx.findPidsByProfile(profileDir);
    assert.ok(
      viaProc.includes(parent.pid) && viaProc.includes(child.pid),
      `应能从 /proc 反查到两个进程，实际 ${JSON.stringify(viaProc)}`,
    );

    const result = await ctx.reapBrowserTree(profileDir, { graceMs: 500 });
    assert.equal(result.found, 2, `found 应为 2，实际 ${result.found}`);

    await sleep(300);
    let alive = 0;
    try {
      process.kill(parent.pid, 0);
      alive += 1;
    } catch {
      /* 已死 */
    }
    try {
      process.kill(child.pid, 0);
      alive += 1;
    } catch {
      /* 已死 */
    }
    assert.equal(alive, 0, "两个进程都应被回收");

    await ctx.removeProfileDir(profileDir);
    const remaining = await readdir(root);
    assert.ok(
      !remaining.includes(path.basename(profileDir)),
      "profile 目录应被清理",
    );
  } finally {
    try {
      parent.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("reapBrowserTree 对无匹配进程是安全的空操作", async (t) => {
  if (!isLinux) return t.skip("仅在 Linux 上验证");
  const root = mkdtempSync(path.join(tmpdir(), "onegl-noop-"));
  try {
    await mkdir(path.join(root, "playwright_firefoxdev_profile-NONE01"), { recursive: true });
    const ctx = buildHarness(root);
    const result = await ctx.reapBrowserTree(
      path.join(root, "playwright_firefoxdev_profile-NONE01"),
      { graceMs: 100 },
    );
    // vm 沙箱内的对象原型来自另一个 realm，不能用 deepStrictEqual 跨 realm 比较。
    assert.equal(result.found, 0);
    assert.equal(result.killed, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("close() 必须包含进程树兜底回收，否则会话槽位会被孤儿占死", () => {
  // 静态契约：锁死修法不被后续重构抹掉。
  // 旧代码的 close() 只有 context/browser/virtualDisplay 三行，没有任何兜底。
  // 注意：virtualDisplay 的 close() 缩进相同，因此锚点要带上它前面独有的
  // `async saveAuth()`，避免切到 Xvfb 那个 close()。
  const anchor = source.indexOf("      async saveAuth() {");
  assert.ok(anchor >= 0, "源码中应存在 session.saveAuth()");
  const closeStart = source.indexOf("      async close() {", anchor);
  assert.ok(closeStart >= 0, "saveAuth 之后应紧邻 session.close()");
  const closeBody = source.slice(closeStart, source.indexOf("\n      },", closeStart));

  assert.match(
    closeBody,
    /reapBrowserTree\(profilePath\)/,
    "close() 必须按 profile 回收整棵 camoufox 进程树",
  );
  assert.match(
    closeBody,
    /removeProfileDir\(profilePath\)/,
    "close() 必须清理 profile 目录",
  );

  // launch 阶段必须 diff 出本次的 profile 路径，否则 close() 无从下手。
  assert.match(
    source,
    /profilesBefore = await listProfileDirs\(\);/,
    "启动前须记录已有 profile 集合",
  );
  assert.match(
    source,
    /profilesAfter = await listProfileDirs\(\);/,
    "启动后须重新枚举以便 diff",
  );
  assert.match(
    source,
    /profilePath\s*=\s*[\s\S]{0,120}?profilesAfter[\s\S]{0,80}?profilesBefore\.has\(/,
    "必须 diff 出本次会话专属 profile",
  );
});

test("按 profile 反查进程不依赖 ps（容器镜像不保证有 procps）", () => {
  assert.match(
    source,
    /readFile\(`\/proc\/\$\{pid\}\/cmdline`/,
    "应读取 /proc/<pid>/cmdline",
  );
  assert.ok(
    !/execFileAsync\(\s*["'`]ps["'`]/.test(source),
    "不应依赖 ps 命令",
  );
});
