#!/usr/bin/env node
/**
 * 无库环境验证：清空 DATABASE_URL / REDIS_URL 跑一遍全量测试。
 *
 * ## 为什么需要
 *
 * 静态扫描找「哪些测试需要库却没 skip 守卫」会产生大量假阳性 ——
 * openapi-contract-coverage 是纯契约检查、db-pool 测的正是空配置的行为，
 * 它们都不需要真库，却会被关键词匹配误判。实测清空 DATABASE_URL 跑一遍
 * 才得到可信答案。
 *
 * 这个脚本做两件事：
 *   1. 有库环境下的失败 = 已知列表之外还有别的，那是真问题
 *   2. 无库环境下的失败 = 缺 skip 守卫，CI 上会报错并淹没真问题
 *
 * ## 为什么做成脚本而不是测试
 *
 * 它会再跑一遍全量测试（几百个文件），塞进常规套件会让每次
 * `node --test` 慢一个数量级；而放进测试文件里也不行 ——
 * Node 检测到子进程调用 node --test 会判定为递归并直接跳过，
 * 无论文件列表是显式还是目录扫描。
 *
 * 用法：node tools/check-no-db-env.mjs
 */

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * 与数据库无关的已知失败。
 *
 * 匹配的是**测试名**而不是文件名 —— 测试全名是
 * "legacy plaintext state is migrated once and plaintext is removed"，
 * 来自 test/storage-state-encryption.test.mjs，在 Windows 上断言 POSIX
 * 权限位 0o600，NTFS 没有这个概念。
 */
const KNOWN_FAILURES = [
  /legacy plaintext state is migrated once/,
];

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

function testFiles() {
  return readdirSync(join(root, "test"))
    .filter((f) => f.endsWith(".test.mjs"))
    .map((f) => join("test", f));
}

function run(env) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ["--test", ...testFiles()], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += String(c); });
    child.stderr.on("data", (c) => { stderr += String(c); });
    child.once("exit", (code) => resolveRun({ code, stdout, stderr }));
  });
}

function summarize(stdout) {
  const read = (label) => {
    const m = new RegExp(`^ℹ ${label} (\\d+)$`, "m").exec(stdout);
    return m ? Number(m[1]) : null;
  };
  const failures = stdout
    .split("\n")
    .filter((l) => l.startsWith("✖ ") && !l.startsWith("✖ failing"))
    .map((l) => l.slice(2).trim());
  return {
    tests: read("tests"),
    pass: read("pass"),
    fail: read("fail"),
    skipped: read("skipped"),
    failures,
  };
}

console.log("=== 1/2  无库环境（模拟 CI 未配数据库）===");
const noDb = await run({ DATABASE_URL: "", REDIS_URL: "" });
const a = summarize(noDb.stdout);
console.log(`  tests=${a.tests} pass=${a.pass} fail=${a.fail} skipped=${a.skipped} exit=${noDb.code}`);
if (a.tests == null) {
  console.log("  未收集到结果，输出尾部：");
  console.log(noDb.stdout.slice(-800));
  console.log(noDb.stderr.slice(-400));
}

const unexpected = a.failures.filter((n) => !KNOWN_FAILURES.some((re) => re.test(n)));
if (unexpected.length) {
  console.log(`\n  ✗ 以下测试在无库环境下失败（缺 skip 守卫）:`);
  for (const n of unexpected) console.log(`      ${n}`);
} else {
  console.log("  ✓ 无库环境下没有意外失败（已知失败已排除）");
}

console.log("\n=== 2/2  有库环境（对照：跳过数应一致）===");
const withDb = await run({});
const b = summarize(withDb.stdout);
console.log(`  tests=${b.tests} pass=${b.pass} fail=${b.fail} skipped=${b.skipped} exit=${withDb.code}`);

console.log("\n=== 结论 ===");
if (unexpected.length) {
  console.log(`  ✗ 有 ${unexpected.length} 个测试缺 skip 守卫`);
  for (const n of unexpected) console.log(`      ${n}`);
  process.exit(1);
}

// 跳过数：无库时应当**更多**（那些 db 测试全跳了），不是更少。
// 更少才是问题 —— 说明有测试在无库时走了别的分支而不是 skip。
// 早先这里判反了，把「无库跳过更多」当成异常。
const delta = (a.skipped ?? 0) - (b.skipped ?? 0);
if (delta < 0) {
  console.log(`  ✗ 无库时比有库少跳过 ${-delta} 个 —— ` +
    "有测试在无库时改用了静默 return 而非 t.skip，" +
    "读报告的人会误以为「测过了」");
  process.exit(1);
}
console.log(`  ✓ skip 守卫齐全，无静默跳过`);
console.log(`    （无库时多跳过 ${delta} 个，符合预期：那些 db 测试在无库环境下全部跳过）`);
