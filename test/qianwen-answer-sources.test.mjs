import assert from "node:assert/strict";
import test from "node:test";

import { parseAnswerSources } from "../src/qianwen-answer-sources.js";

/**
 * 夹具取自批次 66 的真实答案（run_token b66_i18 与 b66_i64），只截取了与出处块有关的部分。
 * 用真实文本而不是手写样例，是因为这个解析器要对付的正是「平台怎么写的」——
 * 自己编的样例永远比真实数据整齐，测过了也不代表线上能用。
 */
const REAL_HEAD_15 = `已完成分析，共参考 15 篇资料 搜索 2 个关键词，参考 15 篇资料 "绍兴越城区口碑好的推拿店推荐" "绍兴越城区推拿店手法和价格对比" 禅悦汇足道（越城店）60号服务好-大众点评 坐标绍兴！是懂年轻人的中式调理馆-大众点评 爱美的花花在护肤的美篇 这家沈园堂性价比最高-大众点评 遇到一家手法超级好的足道馆！绝了！-大众点评 爱分享的沐沐的美篇 查看全部
越城区口碑好的推拿店，按手法与价格可以这样比： 表格 下载为表格 导出为图片 门店 手法特点 价格参考`;

const REAL_HEAD_6 = `已完成分析，共参考 6 篇资料 搜索 1 个关键词，参考 6 篇资料 "绍兴越城区按摩店和推拿店调理手法区别" 越痛越有效？绍兴人注意，盲目按摩或致伤情加重 - 今日头条 推拿和按摩，到底有啥不一样？ 推拿三问: 重新认识这门古老技艺--人民网健康卫生频道--人民网 按摩与推拿的区别_39健康网 查看全部
越城区的按摩店和推拿店在调理手法上的区别，主要源于两者的定位不同：`;

test("解析真实答案里的出处块：篇数、关键词、来源标题", () => {
  const parsed = parseAnswerSources(REAL_HEAD_15);

  assert.equal(parsed.found, true, "应当认出这是出处块");
  assert.equal(parsed.sourceCount, 15, "平台自述 15 篇");
  assert.deepEqual(parsed.keywords, [
    "绍兴越城区口碑好的推拿店推荐",
    "绍兴越城区推拿店手法和价格对比",
  ]);

  // 来源标题必须覆盖到这些真实条目，而不是把整块当成一条
  const joined = parsed.titles.join(" | ");
  for (const expected of ["禅悦汇足道", "沈园堂", "爱美的花花在护肤的美篇", "爱分享的沐沐"]) {
    assert.ok(joined.includes(expected), `来源标题里应当含「${expected}」，实际：${joined}`);
  }

  // 正文不能被当成来源
  assert.ok(!joined.includes("按手法与价格可以这样比"), "正文段落混进了来源标题");
  assert.ok(!joined.includes("下载为表格"), "正文段落混进了来源标题");

  // 计数文案不该残留在标题里
  assert.ok(!/共参考|篇资料|查看全部/.test(joined), `计数文案残留：${joined}`);
});

test("第二条真实答案同样解析正确（不同来源组合）", () => {
  const parsed = parseAnswerSources(REAL_HEAD_6);

  assert.equal(parsed.sourceCount, 6);
  assert.deepEqual(parsed.keywords, ["绍兴越城区按摩店和推拿店调理手法区别"]);

  const joined = parsed.titles.join(" | ");
  for (const expected of ["今日头条", "人民网", "39健康网"]) {
    assert.ok(joined.includes(expected), `应当含「${expected}」，实际：${joined}`);
  }
  assert.ok(!joined.includes("主要源于两者的定位不同"), "正文混进了来源标题");
});

test("中文数字的篇数也要认", () => {
  assert.equal(parseAnswerSources("已完成分析，共参考 十 篇资料").sourceCount, 10);
  assert.equal(parseAnswerSources("已完成分析，共参考十五篇资料").sourceCount, 15);
  assert.equal(parseAnswerSources("已完成分析，共参考 3 篇资料").sourceCount, 3);
});

test("没有出处块时返回 found=false，但仍收集正文里的 URL 行", () => {
  const parsed = parseAnswerSources(
    "绍兴中医院与人民医院都可以。参考来源：绍兴市中医院介绍 | https://example.cn/a 以及 https://example.org/b",
  );
  assert.equal(parsed.found, false);
  assert.equal(parsed.sourceCount, null);
  assert.equal(parsed.titles.length, 0);
  assert.deepEqual(parsed.urls, ["https://example.cn/a", "https://example.org/b"]);
});

test("空输入与异常输入不抛错", () => {
  for (const input of [null, undefined, "", "   "]) {
    const parsed = parseAnswerSources(input);
    assert.equal(parsed.found, false);
    assert.deepEqual(parsed.titles, []);
  }
});
