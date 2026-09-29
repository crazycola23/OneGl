import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * 指纹轮换的作用域按「匿名属性」判定，不按平台名白名单。
 *
 * ## 真实缺陷
 *
 * `prepareWindow` 原来查 `ONEGL_WINDOW_RESET_PROVIDERS` 白名单，而它被设成
 * `qianwen`。于是豆包（走匿名面）**从不换指纹**。
 *
 * 匿名面没有可继承的身份 —— 平台能用来区分「同一台机器回访」的只有指纹。
 * 不换的后果实测可见：豆包页面出现「登录」提示，6 连问全部
 * DOUBAO_SUBMISSION_FAILED（details.sentByButton=false）。
 *
 * ## 为什么白名单是错的写法
 *
 * 要靠人维护两件事：
 *   - 新增一个匿名平台，要记得加进白名单
 *   - 某个平台改回登录态，要记得从白名单里删掉
 * 两次都是「忘了就静默出问题」。而 `adapter.requiresStoredAuth === false`
 * 是适配器自己声明的事实，两个方向都不用记。
 */

const worker = readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");

function functionBody(name) {
  const asyncAt = worker.indexOf(`async function ${name}`);
  const start = asyncAt >= 0 ? asyncAt : worker.indexOf(`function ${name}`);
  assert.ok(start >= 0, `应能找到 ${name}`);
  const declEnd = worker.indexOf("{", start);
  const next = worker.indexOf("\nfunction", declEnd);
  return worker.slice(start, next > declEnd ? next : worker.length);
}

test("轮换作用域按 requiresStoredAuth 判定", () => {
  const body = functionBody("prepareWindow");
  assert.match(body, /adapter\.requiresStoredAuth === false/,
    "判据应是「当前跑的是匿名面」，而不是平台名白名单");
});

test("不再按平台名白名单判定", () => {
  const body = functionBody("prepareWindow");
  assert.ok(!body.includes("windowResetProviders"),
    "prepareWindow 不应再读平台名白名单");
});

test("匿名面必须换指纹，登录态不换", () => {
  const body = functionBody("prepareWindow");
  // 换身份的分支被匿名属性守卫
  assert.match(body, /if \(every > 0 && anonymous\)/,
    "换指纹只在匿名面触发");
  // 而登录态走下面的换窗口路径
  assert.match(body, /shouldRotateContext/,
    "登录态仍走换窗口（不冷启动，保住账号会话身份）");
});

test("注释记录了实测证据与白名单的教训", () => {
  // 后人若要改回白名单写法，得先知道为什么不能用
  assert.match(worker, /DOUBAO_SUBMISSION_FAILED/,
    "应记录触发这个判断的实测错误码");
  assert.match(worker, /白名单/,
    "应写明白名单写法的维护负担");
});
