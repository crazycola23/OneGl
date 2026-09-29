import assert from "node:assert/strict";
import test from "node:test";

import { getLatestGeoCustomerReport } from "../src/reporting/geo-customer-reports.js";

/**
 * 「按任务/任务组对比」的定位逻辑。
 *
 * 起因：对比端点原先只接受两个 report_id，但 report_id 是生成报告时才产生的
 * 内部标识。调用方实际持有的是两个任务，于是要先查历史、从列表里挑 id、
 * 再手工配对 —— 既把内部 ID 泄漏成调用方负担，也容易挑错报告。
 *
 * 这里用 fakePool 验证三件事：public_id 正确解析成内部主键、租户边界不被跨越、
 * 找不到时返回 null 而不是抛错。
 */

function fakePool({ taskRow = null, groupRow = null, reportRows = [] } = {}) {
  const calls = [];
  const respond = (sql) => {
    // 解析 scope 的那条 SQL 里有两个标量子查询，都返回单行
    if (/AS task_db_id/.test(sql)) {
      return [{ task_db_id: taskRow, group_db_id: groupRow }];
    }
    if (/FROM service_geo_reports r/.test(sql)) return reportRows;
    return [];
  };
  return {
    calls,
    async query(sql, params) {
      const text = String(sql);
      calls.push({ sql: text, params });
      const rows = respond(text);
      return { rows, rowCount: rows.length };
    },
  };
}

test("group public_id 解析成内部主键后再查报告", async () => {
  const pool = fakePool({ groupRow: 77, reportRows: [{ public_id: "rpt_x" }] });
  const got = await getLatestGeoCustomerReport(pool, { tenantId: 1, groupId: "grp_abc" });
  assert.equal(got, "rpt_x");

  // 关键回归：早期版本把 public_id 直接当 bigint 比对，会报
  // invalid input syntax for type bigint。
  // 参数顺序是 [tenantId, taskDbId, groupDbId] —— 只给 group 时 task 位为 null。
  const reportQuery = pool.calls.at(-1);
  assert.equal(reportQuery.params[1], null, "只给 group 时 taskDbId 为 null");
  assert.equal(reportQuery.params[2], 77, "传进 SQL 的 group 必须是内部主键 77，不是 grp_abc");
});

test("task public_id 同样解析成内部主键", async () => {
  const pool = fakePool({ taskRow: 12, reportRows: [{ public_id: "rpt_y" }] });
  const got = await getLatestGeoCustomerReport(pool, { tenantId: 1, taskId: "tsk_abc" });
  assert.equal(got, "rpt_y");
  const q = pool.calls.at(-1);
  assert.equal(q.params[1], 12, "task 走 taskDbId 位");
  assert.equal(q.params[2], null);
});

test("租户边界：解析不到就返回 null，不泄漏跨租户报告", async () => {
  const pool = fakePool({ groupRow: null, reportRows: [] });
  const got = await getLatestGeoCustomerReport(pool, { tenantId: 999, groupId: "grp_abc" });
  assert.equal(got, null);
  // 解析失败时不应该再去查 reports 表
  assert.equal(pool.calls.length, 1, "只做了一次 scope 解析");
});

test("scope 存在但没有报告 → null", async () => {
  const pool = fakePool({ groupRow: 77, reportRows: [] });
  const got = await getLatestGeoCustomerReport(pool, { tenantId: 1, groupId: "grp_abc" });
  assert.equal(got, null);
});

test("缺 scope 直接报错", async () => {
  const pool = fakePool({});
  await assert.rejects(
    () => getLatestGeoCustomerReport(pool, { tenantId: 1 }),
    /task_id or group_id is required/,
  );
});
