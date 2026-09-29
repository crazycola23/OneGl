import assert from "node:assert/strict";
import test from "node:test";

import "dotenv/config";

import { createPool } from "../src/db/pool.js";

/**
 * 报告快照的向后兼容与主题一致性。
 *
 * 关注两件事：
 *
 * 1. **主题进 content_hash** —— 报告是固定快照，artifact_html 是生成时
 *    渲染好的。若 theme 不参与哈希，同一份 payload 换个主题也能通过校验，
 *    「固定快照」这个承诺就不成立了。
 *
 * 2. **旧快照仍可读** —— theme 字段是后加的。存量快照的 payload 里没有它，
 *    而 contentHash(payload) 重算时读的就是存进去的那个对象本身，
 *    所以理论上必然一致。但「理论上」不算验证过 ——
 *    这里用真实存量数据确认，失败就是 500 report_snapshot_integrity_error。
 */

const enabled = Boolean(process.env.DATABASE_URL);
const G = "grp_957395ef23e54498aef8b72cd6b9ebb7";
const mk = (k, l) => ({
  key: k, label: l, from: "2026-09-25", to: "2026-09-26", time_zone: "Asia/Shanghai",
});

test("theme 参与 content_hash，且旧快照仍能通过完整性校验", { skip: !enabled, timeout: 120_000 }, async () => {
  const pool = createPool();
  const { createGeoCustomerReport, getGeoCustomerReport } =
    await import("../src/reporting/geo-customer-reports.js");
  const made = [];

  try {
    // ---- 主题进 hash ----
    const plain = await createGeoCustomerReport(pool, {
      tenantId: 1, groupId: G,
      input: { periods: [mk("plain", "无主题")], brands: [{ name: "思邈棠" }] },
    });
    made.push(plain.report_id);

    const themed = await createGeoCustomerReport(pool, {
      tenantId: 1, groupId: G,
      input: {
        periods: [mk("themed", "有主题")],
        brands: [{ name: "思邈棠" }],
        theme: { colors: { accent: "#0f766e" }, footer_text: "客户署名" },
      },
    });
    made.push(themed.report_id);

    assert.notEqual(plain.content_hash, themed.content_hash,
      "不同主题必须产生不同的 content_hash —— 否则「固定快照」名不副实");

    // 读回时主题原样透出，且能通过完整性校验（校验失败会抛 500）
    const plainRead = await getGeoCustomerReport(pool, { tenantId: 1, reportPublicId: plain.report_id });
    assert.equal(plainRead.theme, null, "未传主题时 theme 为 null");
    assert.equal(plainRead.content_hash, plain.content_hash);

    const themedRead = await getGeoCustomerReport(pool, { tenantId: 1, reportPublicId: themed.report_id });
    assert.equal(themedRead.theme?.colors?.accent, "#0f766e", "主题应从快照读回");
    assert.equal(themedRead.theme?.footer_text, "客户署名");
    assert.equal(themedRead.content_hash, themed.content_hash);

    // ---- 旧快照（payload 里没有 theme 字段）----
    const legacy = await pool.query(`
      SELECT r.public_id
        FROM service_geo_reports r
        JOIN service_geo_report_revisions rev ON rev.report_id = r.id
       WHERE r.tenant_id = 1
         AND NOT (rev.payload ? 'theme')
       ORDER BY r.id
       LIMIT 1`);

    if (legacy.rows.length) {
      // 这条最重要：存量快照如果过不了完整性校验，读它就会 500，
      // 而 500 对调用方来说完全无法理解（他们不知道自己的报告"过期"了）。
      const legacyRead = await getGeoCustomerReport(pool, {
        tenantId: 1, reportPublicId: legacy.rows[0].public_id,
      });
      assert.ok(legacyRead, "没有 theme 字段的历史快照仍应可读");
      assert.equal(legacyRead.theme ?? null, null, "历史快照的 theme 表现为 null");
    } else {
      // 没有存量数据可验时不静默跳过 —— 明确说出来
      console.log("[提示] 没有不含 theme 字段的历史快照可验证（该字段是近期新增）");
    }
  } finally {
    if (made.length) {
      await pool.query("DELETE FROM service_geo_reports WHERE public_id = ANY($1::text[])", [made])
        .catch(() => undefined);
    }
    await pool.end().catch(() => undefined);
  }
});
