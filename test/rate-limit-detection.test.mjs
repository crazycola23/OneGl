import assert from "node:assert/strict";
import test from "node:test";
import { isProviderThrottleText } from "../src/doubao.js";

test("代理 IP 匿名面实测到的原文必须被判成限流", () => {
  // 2026-10-16 现场截图原文。旧正则（请求过于频繁|操作频繁|稍后再试）全部漏掉，
  // 结果这条明确限流被报成 ANSWER_NOT_FOUND，看起来像「平台没建会话」。
  assert.equal(isProviderThrottleText("当前服务访问频繁，请稍后重试"), true);
});

test("历史已知的限流文案继续被识别", () => {
  for (const text of [
    "请求过于频繁，请稍后再试",
    "操作频繁",
    "已达到今日上限",
    "额度不足",
    "当前服务繁忙",
  ]) {
    assert.equal(isProviderThrottleText(text), true, text);
  }
});

test("正常答案文本不会被误判成限流", () => {
  for (const text of [
    "绍兴越城区推拿按摩推荐以下几家，手法以推拿和艾灸为主。",
    "该平台的服务介绍里提到频繁到店有折扣。",
    "",
    null,
    undefined,
  ]) {
    assert.equal(isProviderThrottleText(text), false, String(text));
  }
});
