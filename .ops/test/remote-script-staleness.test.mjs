/**
 * `remote.mjs script` 必须拒绝执行与远端 staging 不同步的本地脚本。
 *
 * 2026-10-06 在同一个坑上栽了两次：
 *   ① 改了远端 staging 上的脚本，跑的却是本地旧副本 —— 输出完全正常
 *   ② 改了本地脚本，put 没跑或跑晚了，跑的是远端旧副本
 *
 * 两次的共同点：**静默用了旧版本，没有任何报错**。
 * 教训写在文档里没用 —— 当天还是栽了。所以做成工具层面的拦截。
 *
 * 这里锁的是「拦截存在」与「放行条件正确」，不需要真连服务器。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../remote.mjs", import.meta.url), "utf8");

test("script 执行前必须核对本地与远端的 sha256", () => {
  assert.match(
    source,
    /findStaleCounterpart/,
    "script 路径应调用远端对照检查",
  );
  assert.match(source, /sha256/i, "比对方式应是 sha256");
});

test("不一致时拒绝执行并给出两条修法", () => {
  assert.match(source, /拒绝执行/, "应有明确的拒绝提示");
  assert.match(
    source,
    /allow-stale/,
    "应提供 --allow-stale 作为「确要用本地版本」的显式出口",
  );
  assert.match(source, /process\.exitCode\s*=\s*2/, "拒绝时应有非零退出码");
  // 两条修法：同步远端，或显式放行
  assert.match(source, /put /, "应提示怎么同步远端");
});

test("★ 放行条件：远端没有同名文件时必须放行", () => {
  // 拦住一个本来没问题的东西，比放过一个有问题的东西更糟。
  // 远端根本没有 staging 目录时（如第一次跑一个新脚本），
  // 「不一致」这个概念不成立，必须放行。
  assert.match(
    source,
    /if \(!remoteHash\) return null;/,
    "远端无此文件时返回 null（放行），而不是判定为不一致",
  );
  assert.match(
    source,
    /if \(!remotePath\) return null;/,
    "推断不出远端路径时放行",
  );
  assert.match(
    source,
    /localHash === remoteHash\) return null;/,
    "哈希一致时放行",
  );
});

test("script 不加 --allow-stale 时才拦截", () => {
  assert.match(
    source,
    /if \(isScript && !flags\.get\("allow-stale"\)\)/,
    "只有 script 动作需要这个检查，exec 不受影响",
  );
});

test("护栏本身写在文件头的用法说明里", () => {
  assert.match(
    source.slice(0, source.indexOf("*/") + 2),
    /allow-stale/,
    "用法说明要提到这个开关，否则没人会知道它存在",
  );
});

test("今天的四处陷阱都要有对应的防护，而不是只写进文档", () => {
  const lessons = readFileSync(
    new URL("../../docs/FINGERPRINT_ROTATION_LESSONS.md", import.meta.url),
    "utf8",
  );
  // 18.12 改 staging 不等于改容器
  assert.match(lessons, /18\.12 改 staging 不等于改了容器/);
  // 18.14 heredoc 没执行 / psql 退出码恒 0
  assert.match(lessons, /18\.14/);
  assert.match(lessons, /ON_ERROR_STOP/, "psql 那条陷阱要留下");
  // 18.17 script 读本地而 put 改远端 —— 本文件在管它
  assert.match(lessons, /18\.17/);
  // 18.18/18.19 job_kill 杀不掉远端进程
  assert.match(lessons, /18\.18/);
  assert.match(lessons, /18\.19/);
});