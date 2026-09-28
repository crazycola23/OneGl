/**
 * 「这次运行的引用可以进入来源统计」的判定口径。
 *
 * ## 为什么要有这个文件
 *
-- 判定条件被复制在十几个 SQL 片段里（dashboard、report、brand-source-intelligence、
 * geo-customer-reports 各有一份），而且每一份都硬编码了同一组 citation_state 取值。
 * 代价是：当某个平台引入新的 citation_state 词表时，漏改一处就出现「引用统计为 0」
 * 的静默错误 —— 数字看起来合法（0 也是数字），没有任何告警。
 *
 * ## citation_state 的词表是**按平台**的，不是全局的
 *
 * 采集侧每个平台自己决定怎么描述引用抓取状态，实测词表并不一致：
 *
 *   doubao: 'found' | 'none_visible' | 'count_mismatch' | 'self-reported-count' | 'dom-only'
 *   qianwen: 'ok' | 'count_mismatch'          （src/qianwen.js: state: complete ? "ok" : "count_mismatch"）
 *   zhipu / wenxin: 'self-reported-count' | 'dom-only'
 *
 * 语义对齐关系（这是本文件存在的核心）：
 *
 *   found / ok        抓到了引用，且与平台自报数量核对通过
 *   none_visible      本轮确实没有对用户可见的引用（不是解析失败）
 *   dom-only          只有 DOM 可见引用，平台未自报数量
 *   count_mismatch    抓到的条数与平台自报数量对不上 —— 解析不可信
 *   self-reported-count 平台自报了数量但未读到 DOM 引用 —— 解析不可信
 *
 * 前三类代表「引用证据可信」，后两类代表「不完整或对不上」，必须排除。
 *
 * 旧口径只认 ('found','none_visible')，于是千问的 94 条 'ok' 全部被当成无效，
 * 报告里千问侧的引用数显示为 0 —— 与实际 992 条完全不符。
 */

/** 引用证据可信、可进入来源统计的 citation_state 取值。 */
export const CITATION_EVIDENCE_STATES = Object.freeze([
  "found",        // 豆包：抓到引用且核对通过
  "ok",           // 千问：抓到引用且核对通过（同 found 语义，平台词表不同）
  "none_visible", // 本轮无可见引用 —— 有效观察，不是失败
  "dom-only",     // 只有 DOM 引用，平台未自报数量
]);

/** 引用证据不可信、必须排除的 citation_state 取值。 */
export const CITATION_UNRELIABLE_STATES = Object.freeze([
  "count_mismatch",        // 抓到条数与平台自报数量不符
  "self-reported-count",   // 平台自报数量但没读到引用
]);

const STATE_LIST = CITATION_EVIDENCE_STATES.map((state) => `'${state}'`).join(", ");

/**
 * 引用统计的完整 WHERE 片段（不含 runs 表别名，调用方自己带）。
 *
 * 用法：`WHERE r.sampling_batch_id = ANY($1) AND ${citationValidRunSql('r')}`
 */
export function citationValidRunSql(alias = "r") {
  return (
    `${alias}.status = 'success' ` +
    `AND ${alias}.conversation_reset_confirmed IS TRUE ` +
    `AND ${alias}.citation_state IN (${STATE_LIST})`
  );
}
