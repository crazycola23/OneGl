import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isSilentlyDropped, noFirstTokenWindowMs } from "../src/no-first-token.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (relative) => fs.readFileSync(path.join(root, "..", relative), "utf8");

const qianwenSource = read("src/qianwen.js");
const doubaoSource = read("src/doubao.js");

test("判据只认「从未出现过答案」", () => {
  const windowMs = 180_000;
  // 见过的唯一形态：提交后一路零字，越过了窗口
  assert.equal(isSilentlyDropped({ answerLength: 0, firstTokenSeen: false, waitedMs: windowMs, windowMs }), true);
  assert.equal(isSilentlyDropped({ answerLength: 0, firstTokenSeen: false, waitedMs: windowMs + 1, windowMs }), true);

  // 还没到窗口：继续等
  assert.equal(isSilentlyDropped({ answerLength: 0, firstTokenSeen: false, waitedMs: windowMs - 1, windowMs }), false);

  // 本次采样里已经有答案
  assert.equal(isSilentlyDropped({ answerLength: 12, firstTokenSeen: false, waitedMs: 900_000, windowMs }), false);

  // 曾经出现过答案 —— 这条最重要：页面重渲染会让某次采样读到 0，那不是「没答」，
  // 拿它当判据就会把慢任务误杀，而误杀不可逆（提问已经提交，重跑就是重复提问）。
  assert.equal(isSilentlyDropped({ answerLength: 0, firstTokenSeen: true, waitedMs: 900_000, windowMs }), false);
  assert.equal(isSilentlyDropped({ answerLength: 0, firstTokenSeen: true, waitedMs: 0, windowMs }), false);
});

test("容忍窗只认合法覆盖值，且不得低于 30s 下限", () => {
  const name = "ONEGL_TEST_FIRST_TOKEN_MS";
  const original = process.env[name];
  try {
    delete process.env[name];
    assert.equal(noFirstTokenWindowMs(name, 180_000), 180_000, "未配置时用默认值");

    process.env[name] = "240000";
    assert.equal(noFirstTokenWindowMs(name, 180_000), 240_000, "合法覆盖值应当生效");

    // 低于下限的窗口会把「平台正在排队/预热」误判成吞请求，一律回落。
    process.env[name] = "1000";
    assert.equal(noFirstTokenWindowMs(name, 180_000), 180_000, "低于 30s 下限必须回落");

    process.env[name] = "abc";
    assert.equal(noFirstTokenWindowMs(name, 180_000), 180_000, "非数字必须回落");
  } finally {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
});

test("千问与豆包接的是同一套判据，各自带环境变量与首字日志", () => {
  const platforms = [
    { label: "千问", source: qianwenSource, env: "ONEGL_ANSWER_FIRST_TOKEN_MS", log: "[qianwen] first-token" },
    { label: "豆包", source: doubaoSource, env: "ONEGL_DOUBAO_FIRST_TOKEN_MS", log: "[doubao] first-token" },
  ];
  for (const { label, source, env, log } of platforms) {
    // 判据必须来自共享模块，而不是各自抄一份
    assert.match(
      source,
      /import \{ isSilentlyDropped, noFirstTokenWindowMs \} from "\.\/no-first-token\.js";/,
      `${label} 没有从共享模块引入零输出判据`,
    );
    assert.match(source, /isSilentlyDropped\(\{/, `${label} 没有调用零输出判据`);
    assert.match(source, new RegExp(env), `${label} 的容忍窗必须是可配置的`);
    // 首字延迟日志是校准容忍窗的唯一数据源：没有它，这个值就只能靠推理一直错下去
    assert.ok(source.includes(log), `${label} 缺少首字延迟日志（${log}）`);
  }
});

test("两个平台的容忍窗默认值一致，且都远小于 900s 预算", () => {
  const defaults = [qianwenSource, doubaoSource].map((source) => {
    const match = source.match(/const [A-Z_]*FIRST_TOKEN_MS_DEFAULT = ([0-9_]+);/);
    assert.ok(match, "找不到容忍窗默认值常量");
    return Number(match[1].replaceAll("_", ""));
  });
  assert.equal(defaults[0], defaults[1], "两个平台应当用同一个保守默认值，除非各自的实测分布已经分岔");
  // 千问实测首字延迟尾部 97s；窗口必须离它足够远，同时仍显著小于 900s 预算 —— 否则「提前退出」
  // 既可能误杀，又省不下时间。
  assert.ok(defaults[0] >= 150_000 && defaults[0] < 900_000, `默认值 ${defaults[0]}ms 不合理`);
});
