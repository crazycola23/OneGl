import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { ACCOUNT_BLOCKING_CODES } from "../src/accounts/safety.js";

/**
 * 登录失效必须被识别成登录问题，而不是笼统的 PAGE_CHANGED。
 *
 * ## 真实缺陷（实测数据）
 *
 * 批次 69 的 6 条 `PAGE_CHANGED`，details 里 `session.state` 全部是
 * `"login_required"` —— 登录态早已失效。
 *
 * 而账号记录：
 *     status=login_required  consecutive_failures=0  last_error_code=-
 *
 * **登录失效这个事实没有被记到任何地方。** 系统只知道「这一问失败了」，
 * 于是让后面每一问各自失败 —— 整批 50 问白跑，而账号状态从头到尾
 * 没有被标记为需要人工登录。
 *
 * 根因：`throwForSessionState` 只处理 `verification_required` 与
 * `access_restricted`，漏了 `login_required`，于是落到调用方的兜底分支
 * 抛 `PAGE_CHANGED` —— 而 `PAGE_CHANGED` 不在 `ACCOUNT_BLOCKING_CODES` 里，
 * 不会触发账号状态更新。
 *
 * 修复后：第一条遇��登录失效的问就抛 `SESSION_EXPIRED` / `LOGIN_REQUIRED`，
 * 两者都在 ACCOUNT_BLOCKING_CODES 里，账号立即被标记为需人工处理，
 * 后续问不再逐个浪费。
 */

const guard = readFileSync(new URL("../src/front-end-guard.js", import.meta.url), "utf8");

function functionBody(name) {
  const start = guard.indexOf(`function ${name}`);
  assert.ok(start >= 0, `应能找到 ${name}`);
  const declEnd = guard.indexOf("{", start);
  const next = guard.indexOf("\nfunction", declEnd);
  return guard.slice(start, next > declEnd ? next : guard.length);
}

test("throwForSessionState 处理 login_required", () => {
  const fn = functionBody("throwForSessionState");
  assert.match(fn, /state\?\.state === "login_required"/,
    "登录失效必须在这里被识别，不能落到调用方的兜底 PAGE_CHANGED");
});

test("区分「从未登录」与「登录态失效」", () => {
  const fn = functionBody("throwForSessionState");
  assert.match(fn, /hadStoredAuth \? ErrorCode\.SESSION_EXPIRED : ErrorCode\.LOGIN_REQUIRED/,
    "有过登录态是 SESSION_EXPIRED，没有是 LOGIN_REQUIRED —— 运维提示不同");
});

test("两个码都在 ACCOUNT_BLOCKING_CODES 里（否则账号不会被标记）", () => {
  assert.ok(ACCOUNT_BLOCKING_CODES.DOUBAO_LOGIN_REQUIRED,
    "LOGIN_REQUIRED 必须会触发账号状态更新");
  assert.ok(ACCOUNT_BLOCKING_CODES.DOUBAO_SESSION_EXPIRED,
    "SESSION_EXPIRED 必须会触发账号状态更新");
  // 而 PAGE_CHANGED 不会 —— 这正是原缺陷让登录失效被吞掉的原因
  assert.equal(ACCOUNT_BLOCKING_CODES.DOUBAO_PAGE_CHANGED, undefined,
    "PAGE_CHANGED 不是账号级阻塞码，所以笼统抛它等于丢掉了「需要重新登录」这个事实");
});

test("login_required 的 details 标记 promptSubmitted:false", () => {
  // preflight 阶段还没碰输入框，提问不可能已提交 → 可安全重试
  const fn = functionBody("throwForSessionState");
  assert.match(fn, /promptSubmitted: false/,
    "未提交才能安全重试；标错会造成重复提问");
});

test("hasStoredStorageState 已正确导入", () => {
  assert.match(guard, /import \{ hasStoredStorageState \} from "\.\/security\/storage-state\.js"/,
    "第一版改到 front-end-guard 时漏了这个导入，会在运行时 ReferenceError");
});

test("三个调用点都传了 hadStoredAuth", () => {
  const calls = [...guard.matchAll(/throwForSessionState\(session(, stateOpts)?\)/g)];
  assert.equal(calls.length, 3, "应有三个调用点");
  const withOpts = calls.filter((c) => c[1]).length;
  assert.equal(withOpts, 3,
    "三个调用点都要传 stateOpts —— 漏一个就退回 LOGIN_REQUIRED，提示会不准");
});

test("hadStoredAuth 只查一次（不随轮询重复读盘）", () => {
  assert.match(guard, /const stateOpts = \{ hadStoredAuth \}/,
    "查一次结果给三处复用 —— 每轮 poll 都读一次存储态是多余 IO");
});
