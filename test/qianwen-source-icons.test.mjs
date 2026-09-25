import assert from "node:assert/strict";
import test from "node:test";

import { decodeProxyImageSources, sourceLabel } from "../src/qianwen-source-icons.js";

/**
 * 夹具取自 2026-09-24 真实页面上的 `reference-wrap` 图标。
 * `key=` 是 base64 编码的原始 URL —— 解码错一位，抓到的域名就是错的，
 * 而错域名比没有域名更糟：报告会拿它去做投放决策。
 */
const REAL_SRC_1 =
  "http://s2.zimgs.cn/ims?at=smstruct&kt=url&key=aHR0cHM6Ly9jZG4uc20uY24vdGVtcC8yMDI1MTIwNDExMTEwMC1oeDNkcDQ4cjFzMTU2cG05amhoangxcHpqOHE2NWdnZi5wbmc=&sign=yx:0xrLx3gSR81I6Ix7D6nQ0fFRo94=&tv=0_0&p=";
const REAL_SRC_2 =
  "http://s2.zimgs.cn/ims?at=smstruct&kt=url&key=aHR0cHM6Ly9ndy5hbGljZG4uY29tL0wxLzcyMy8xNTY1MzM0MDE0L2MxLzU1LzUzL2MxNTU1M2E3ZDJlZGQ2MGY5Y2VmYzgwZDViOTE4NGQzLmljbw==&sign=yx:hjS-Mu0UT3gtI0V8svolB05BCK0=&tv=0_0&p=";

test("从真实图标的代理 URL 解码出原始来源", () => {
  const decoded = decodeProxyImageSources([REAL_SRC_1, REAL_SRC_2]);

  assert.equal(decoded.length, 2, "两个图标应解出两条来源");
  assert.equal(decoded[0].host, "cdn.sm.cn");
  assert.ok(decoded[0].url.startsWith("https://cdn.sm.cn/"), decoded[0].url);
  assert.equal(decoded[1].host, "gw.alicdn.com");
  assert.ok(decoded[1].url.startsWith("https://gw.alicdn.com/"), decoded[1].url);
});

test("同域名去重：一排图标里常有多个同站来源", () => {
  const same = [REAL_SRC_1, REAL_SRC_1, REAL_SRC_2];
  const decoded = decodeProxyImageSources(same);
  assert.equal(decoded.length, 2, "同域名只保留一条");
});

test("非图片代理的 src 与坏数据被忽略，不抛错", () => {
  const decoded = decodeProxyImageSources([
    "https://example.com/logo.png",          // 不是代理 URL，没有 key
    "http://s2.zimgs.cn/ims?key=bm90LWEtdXJs", // key 解出来不是 URL
    null,
    undefined,
    "",
    "not a url at all",
  ]);
  assert.deepEqual(decoded, []);
});

test("域名收敛成可读来源名", () => {
  assert.equal(sourceLabel("m.dianping.com"), "大众点评");
  assert.equal(sourceLabel("www.meipian.cn"), "美篇");
  assert.equal(sourceLabel("health.people.cn"), "人民网");
  assert.equal(sourceLabel("www.shaoxing.com.cn"), "绍兴网");
  assert.equal(sourceLabel("unknown-site.example"), "unknown-site.example");
});

test("空输入不抛错", () => {
  assert.deepEqual(decodeProxyImageSources([]), []);
  assert.deepEqual(decodeProxyImageSources(null), []);
});
