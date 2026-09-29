import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";

/**
 * 图标域识别：必须用归一化后的域名，不能用 canonical_url 里的主机名。
 *
 * ## 真实缺陷
 *
 * `ICON_DOMAINS = ["cdn.sm.cn", "gw.alicdn.com"]` 拿去比 `articles.normalized_domain`，
 * 而后者在落库时已剥掉子域，实际存的是 `sm.cn` / `alicdn.com`。
 * 后果：
 *   - `icon_citations` 恒为 0（第 9 节那张卡片永远是 0）
 *   - 千问 166 次图标引用混进「内容来源排行」，
 *     客户会以为 sm.cn 是个内容站点
 *
 * 修复后实测：千问 icon_citations 从 0 变 166，
 * content + icon = visible 两边都成立，来源排行里不再有图标域。
 */
test("ICON_DOMAINS 用归一化后的父域，不是 URL 主机名", () => {
  const src = readFileSync(new URL("../src/reporting/geo-customer-reports.js", import.meta.url), "utf8");
  const m = /const ICON_DOMAINS = Object\.freeze\(\[([^\]]+)\]\)/.exec(src);
  assert.ok(m, "应能找到 ICON_DOMAINS 定义");

  const domains = m[1].match(/"([^"]+)"/g).map((s) => s.replaceAll('"', ""));
  // 归一化后的形态：没有子域
  assert.ok(domains.includes("sm.cn"), "应包含归一化后的 sm.cn");
  assert.ok(domains.includes("alicdn.com"), "应包含归一化后的 alicdn.com");
  // 不能是带子域的 URL 主机名 —— 那永远匹配不上 normalized_domain
  assert.ok(!domains.includes("cdn.sm.cn"),
    "cdn.sm.cn 是 URL 主机名，拿它比 normalized_domain 永远匹配不到");
  assert.ok(!domains.includes("gw.alicdn.com"),
    "gw.alicdn.com 同理");
});

test("SQL 里的图标域来自常量，不另写一份", () => {
  const src = readFileSync(new URL("../src/reporting/geo-customer-reports.js", import.meta.url), "utf8");
  // SQL 用 ${ICON_SQL_LIST} 插值，而不是把域名硬编码进字符串
  assert.ok(!src.includes("ARRAY['cdn.sm.cn'"),
    "SQL 里不应再硬编码 URL 主机名");
  assert.ok(!src.includes("ARRAY['sm.cn'"),
    "SQL 里也不该硬编码，应由 ICON_SQL_LIST 从 ICON_DOMAINS 生成");
  assert.match(src, /const ICON_SQL_LIST = ICON_DOMAINS\.map/,
    "ICON_SQL_LIST 应从 ICON_DOMAINS 派生，避免两处各写一份又对不上");
});

test("不再用 LIKE 放宽到任意子域", () => {
  const src = readFileSync(new URL("../src/reporting/geo-customer-reports.js", import.meta.url), "utf8");
  // LIKE '%.' || icon_domain 会把 page.sm.cn 这类真实内容页也判成图标。
  // 归一化后两者同域，报告层无法区分 —— 放宽匹配只会扩大误判面。
  assert.ok(!src.includes("LIKE '%.' || icon_domain"),
    "不应放宽到任意子域");
});

test("报告文案说明归一化关系", () => {
  const html = readFileSync(new URL("../src/report/html-geo-customer.js", import.meta.url), "utf8");
  // 客户看到的是 URL 主机名，库里存的是父域，文案要把这层关系说清楚
  assert.match(html, /cdn\.sm\.cn 与 gw\.alicdn\.com/,
    "应提到采集侧看到的主机名");
  assert.match(html, /归一化为 sm\.cn 与 alicdn\.com/,
    "应说明落库后的归一化形态");
});

/**
 * 已知遗留：报告层无法区分图标与内容页。
 *
 * `cdn.sm.cn/temp/xxx.png`（真图标，77 次引用）与
 * `page.sm.cn/blm/...`（真实内容页，55 次引用）归一化后都是 `sm.cn`。
 *
 * 修复前：两者都混进内容来源排行 → 客户以为 sm.cn 是内容站点
 * 修复后：两者都被标为图标引用 → 至少不再冒充内容来源
 *
 * 彻底解决需要在落库时保留区分（canonical_url 的路径形态可以区分），
 * 属于采集侧改动，不在报告层范围内。实测数据记录在此，避免以后重新踩。
 */
test("已知遗留：归一化后图标与内容页同域，报告层无法区分", () => {
  const REAL_ICON_CITATIONS = 77;
  const CONTENT_PAGE_CITATIONS = 55;
  assert.ok(REAL_ICON_CITATIONS > 0 && CONTENT_PAGE_CITATIONS > 0,
    "实测：sm.cn 下既有真图标也有真实内容页，两者归一化后同域");
  // 这个断言本身是「记录」性质的 —— 它提醒后来者：
  // 若哪天落库侧保留了子域，这里应该改成能区分的用例。
});
