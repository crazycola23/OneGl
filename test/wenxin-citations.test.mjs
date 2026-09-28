import assert from "node:assert/strict";
import test from "node:test";

import {
  citationDiagnostics,
  cleanAnswerText,
  parseReferenceItem,
  parseReferenceItems,
  parseSelfReportedSourceCount,
} from "../src/wenxin-citations.js";

/**
 * 夹具逐字取自 2026-09-28 在本地 Camoufox 出货引擎上的实测输出
 * （记录见 `docs/WENXIN_PHASE0.md`）。
 *
 * 用真实文本而不是手写样例，是因为这一层要对付的正是「平台怎么写的」：
 * 自己编的样例永远比真实数据整齐，测过了也不代表线上能用。
 * 下面每条夹具后面都注明它对应哪个实测现象，以及填错会静默产出什么错数据。
 */

/** 实测答案原文（探针 11 turn 1 的 repr），含 2 个 U+200C。 */
const REAL_ANSWER_RAW =
  "中国的首都是‌北京‌。\n\n"
  + "北京是中华人民共和国的法定首都，1949年9月27日，中国人民政治协商会议决定中华人民共和国定都北平并改名为北京，"
  + "这一地位也在《中华人民共和国宪法》中得到明确。\n\n"
  + "内容由AI生成，仅供参考";

/** 实测参考条目（探针 6，探针 7 复测 23/24 条全部同样形态）。 */
const REAL_REFERENCE = {
  extInfo: '{"link":"https://paper.people.com.cn/rmrbhwb/images/2023-12/20/12/rmrbhwb2023122012.pdf",'
    + '"linkTitle":"\\"数\\"说 2023 中国旅游-人民网",'
    + '"logInfo":{"longpress_content":"thinkinglink"}}',
  text: '1. "数"说 2023 中国旅游-人民网',
};

/** 实测另一个来源：短链 + 站点后缀标题（探针 7 首都题第 1 条）。 */
const REAL_REFERENCE_BAIDU = {
  extInfo: '{"link":"https://baike.baidu.com/item/%E9%A6%96%E9%83%BD/26194",'
    + '"linkTitle":"首都（国家主权的象征城市）_百度百科-百度百科","logInfo":{"longpress_content":"thinkinglink"}}',
  text: "1. 首都（国家主权的象征城市）_百度百科-百度百科",
};

test("剥掉实测到的零宽字符，否则品牌名匹配会全部失配", () => {
  const cleaned = cleanAnswerText(REAL_ANSWER_RAW);
  // 实测：文心把每个强调片段都用 U+200C 包起来，一条 164 字符的答案里有 2 个。
  // 它们在编辑器里和 diff 里都看不见，但 "小米" ≠ "小‌米"，子串匹配会静默失败。
  assert.doesNotMatch(cleaned, /[‌‍﻿]/, "零宽字符必须在入库前剥掉");
  assert.ok(cleaned.includes("中国的首都是北京"), `实际：${cleaned.slice(0, 40)}`);
  // 品牌名匹配的直接后果：带零宽字符的答案永远匹配不到品牌，提及率被低估到 0。
  assert.ok(cleaned.includes("中华人民共和国"));
  assert.ok(cleaned.includes("《中华人民共和国宪法》"));
});

test("整行免责声明被去掉，但答案正文里的同款文案必须留着", () => {
  const cleaned = cleanAnswerText(REAL_ANSWER_RAW);
  assert.doesNotMatch(cleaned, /^内容由AI生成/m, "独立成行的免责声明应当去掉");
  // ⚠️ 只整行匹配，绝不全局替换。zhipu 实测踩过这个坑：`/ChatGLM/g` 把答案正文里
  // 合法出现的产品名一起删掉了，而 run 状态是 success —— 报告里完全看不出来的静默损坏。
  const askedAboutDisclaimer = "文心一言页面的免责声明是「内容由AI生成，仅供参考」，这句话出现在页面底部。\n"
    + "内容由AI生成，仅供参考";
  const kept = cleanAnswerText(askedAboutDisclaimer);
  assert.ok(
    kept.includes("内容由AI生成，仅供参考"),
    "答案正文里提到免责声明时，那一句不能被当成落款删掉",
  );
  assert.equal(kept.split("\n").length, 1, "只去掉独立成行的落款，正文那一行完整保留");
});

test("空段落被折叠，但不做任何内容改写或按长度筛选", () => {
  // 平台把答案渲染成多个 <p>，innerText 里带大量空行。
  const cleaned = cleanAnswerText("第一段。\n\n\n\n第二段。\n\n");
  assert.equal(cleaned, "第一段。\n第二段。");
  // 全角空格也要规范掉，否则品牌名前后挂着不可见空白。
  assert.equal(cleanAnswerText("　小米　SU7　"), "小米 SU7");
  // 非字符串输入不炸：空答案与「答案是空的」必须区分，不能在这里变成异常。
  assert.equal(cleanAnswerText(null), "");
  assert.equal(cleanAnswerText(undefined), "");
});

test("引用 URL 从 data 属性里解析出来，DOM 里的 <a> 不是唯一来源", () => {
  const citation = parseReferenceItem(REAL_REFERENCE);
  assert.ok(citation, "实测的参考条目必须能解析出引用");
  assert.equal(citation.url, "https://paper.people.com.cn/rmrbhwb/images/2023-12/20/12/rmrbhwb2023122012.pdf");
  assert.equal(citation.domain, "paper.people.com.cn");
  assert.equal(citation.title, '"数"说 2023 中国旅游-人民网');
  assert.equal(citation.sourceType, "visible");
  // 这些链接在页面上是长按才出现的菜单项，不是可点的 <a>：下游要知道来源形态。
  assert.equal(citation.capturedFrom, "参考资料列表");

  // 短链 + 站点后缀标题同样要解析出来。
  const baidu = parseReferenceItem(REAL_REFERENCE_BAIDU);
  assert.equal(baidu.url, "https://baike.baidu.com/item/%E9%A6%96%E9%83%BD/26194");
  assert.equal(baidu.domain, "baike.baidu.com");
  assert.ok(baidu.title.includes("百度百科"));
});

test("解析不出来的条目被丢掉，而不是造一条 url 为空的引用", () => {
  // 这一条最关键：db/persist.js 的 prepareCitations 会把缺 url 的引用整条 skip
  //（reason=missing-url）。所以「少解析几条」只是数量少，
  // 而「造一条 url 为空的引用」会让人以为解析成功了，实际下游会再丢一次。
  assert.equal(parseReferenceItem({ extInfo: null, text: "1. 无 data 属性的条目" }), null);
  assert.equal(parseReferenceItem({ extInfo: "不是 JSON", text: "1. 坏数据" }), null);
  assert.equal(parseReferenceItem({ extInfo: '{"link":""}', text: "1. 空链接" }), null);
  assert.equal(parseReferenceItem({ extInfo: '{"link":"javascript:void(0)"}', text: "1. 非 http" }), null);
  assert.equal(parseReferenceItem({ extInfo: '{"title":"只有标题没有链接"}' }), null);
  assert.equal(parseReferenceItem(undefined), null);
  // linkTitle 为空串时回落到条目文本，并去掉序号前缀（实测形态是「1. 标题」）。
  const noTitle = parseReferenceItem({ extInfo: '{"link":"https://example.com/a"}', text: "3、某来源标题" });
  assert.equal(noTitle.url, "https://example.com/a");
  assert.equal(noTitle.title, "某来源标题");
});

test("整份列表按 URL 去重，重复条目不虚增引用数", () => {
  const list = [
    REAL_REFERENCE,
    // 实测同一篇文章可能既在参考列表里、又作为答案里的内联链接出现。
    { ...REAL_REFERENCE },
    REAL_REFERENCE_BAIDU,
  ];
  const citations = parseReferenceItems(list);
  assert.equal(citations.length, 2, "重复 URL 只计一次");
  assert.deepEqual(citations.map((c) => c.domain), ["paper.people.com.cn", "baike.baidu.com"]);
  assert.deepEqual(parseReferenceItems(null), []);
  assert.deepEqual(parseReferenceItems([]), []);
});

test("平台自陈的来源数两种文案都要认，且未观测到时返回 null 而不是 0", () => {
  // 实测两种文案，数字一致。
  assert.equal(parseSelfReportedSourceCount("搜索3个关键词 共参考22篇资料"), 22);
  assert.equal(parseSelfReportedSourceCount("搜索全网32篇资料"), 32);
  assert.equal(parseSelfReportedSourceCount("搜索2个关键词 共参考28篇资料 搜索全网28篇资料"), 28);
  // 「没观测到」和「为零」是两回事：返回 0 会让下游以为平台一个来源都没引用。
  assert.equal(parseSelfReportedSourceCount("你好呀，我是百度自研的文心助手"), null);
  assert.equal(parseSelfReportedSourceCount(""), null);
  assert.equal(parseSelfReportedSourceCount(null), null);
  // 正则锚在「共参考N篇资料」这个共有片段上，所以千问的「已完成分析，共参考 15 篇资料」
  // 也能解析。这是有意的：文心不会产出那句话，认它没有代价；而万一文心哪天改用同款文案，
  // 认它比漏掉好。真正要防的是"无锚点的泛中文匹配"，那会把正文里的数字也当成来源数。
  assert.equal(parseSelfReportedSourceCount("已完成分析，共参考 15 篇资料"), 15);
  // 没有「共参考/搜索全网」锚点时，即便出现"资料"也不该被当成自陈数。
  assert.equal(parseSelfReportedSourceCount("这篇资料写得很清楚，共 12 篇"), null);
});

test("引用数与自陈数对账，三种结论各自可区分", () => {
  // 相等：没有诊断标记。
  assert.deepEqual(citationDiagnostics({ captured: 23, selfReported: 23 }), []);
  // 一条都没抓到但平台说有 22 篇：抓取侧失真。
  assert.deepEqual(citationDiagnostics({ captured: 0, selfReported: 22 }), ["wenxin-no-visible-sources"]);
  // 条数不等：可能少解析了，标出来让下游标 partial 而不是悄悄按抓到的数量出数。
  assert.deepEqual(citationDiagnostics({ captured: 19, selfReported: 23 }), ["wenxin-source-count-mismatch"]);
  // 平台没自陈数时不做对账 —— 「没观测到」不等于「相等」。
  assert.deepEqual(citationDiagnostics({ captured: 19, selfReported: null }), []);
});
