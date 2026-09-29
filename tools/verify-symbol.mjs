#!/usr/bin/env node
/**
 * 符号存在性核查：搜索工具返回「无匹配」时，用它复核再下结论。
 *
 * ## 为什么需要
 *
 * 上一轮我用 grep 搜 `hasStoredStorageState` 得到「无匹配」，
 * 于是断定「这个函数根本不存在」并写了注释。
 * 实际上它在 src/security/storage-state.js:118，doubao.js 早已导入。
 *
 * 代价不是那次判断本身，而是据此产生的所有后续推理 ——
 * 「工具返回空」被当成了「代码里没有」。
 *
 * 写这个脚本时又踩了同一个坑：第一版只把 haystack 转小写、needle 保持原样，
 * 于是 include() 永远匹配不上，**所有符号都报「不存在」** ——
 * 包括那个真实存在的。工具坏了但输出看起来很确定，最坏的一种失败方式。
 *
 * ## 用法
 *
 *   node tools/verify-symbol.mjs hasStoredStorageState
 *   node tools/verify-symbol.mjs front-end-preflight
 *
 * 退出码 0 = 找到，1 = 确实没有（可以用来验证「确实没有」这个判断本身）。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const srcDir = path.join(root, "src");

function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (["node_modules", ".git", ".runtime", "dist", "generated"].includes(name)) continue;
    const full = path.join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) collect(full, out);
    else if (/\.(js|mjs)$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * 搜索符号。
 *
 * 两侧必须同时归一化 —— 第一版只转 haystack，needle 保持原样，
 * include() 永远不匹配，于是全部报「不存在」。那个错误恰好演示了
 * 本脚本要防的那类问题，所以代码里留了注释。
 */
function search(symbol, { caseSensitive = false, includeTests = false } = {}) {
  const needle = caseSensitive ? symbol : symbol.toLowerCase();
  const dirs = [srcDir];
  if (includeTests) dirs.push(path.join(root, "test"));
  const hits = [];

  for (const dir of dirs) {
    let files;
    try { files = collect(dir); } catch { continue; }
    for (const file of files) {
      let original;
      try { original = readFileSync(file, "utf8"); } catch { continue; }
      // 匹配用小写副本，但**输出用原文** —— 否则定位信息全是小写，
      // 复制粘贴出去就搜不到了。搜索用副本、展示用原件，两件事分开。
      const lines = original.split("\n");
      const haystack = caseSensitive ? lines : lines.map((l) => l.toLowerCase());
      lines.forEach((line, i) => {
        if (haystack[i].includes(needle)) {
          hits.push({ file: path.relative(root, file), line: i + 1, text: line.trim() });
        }
      });
    }
  }
  return hits;
}

const [symbol, ...flags] = process.argv.slice(2);
if (!symbol) {
  console.error("用法: node tools/verify-symbol.mjs <symbol> [--tests] [--case]");
  process.exit(2);
}
const includeTests = flags.includes("--tests");
const caseSensitive = flags.includes("--case");

const hits = search(symbol, { caseSensitive, includeTests });

if (!hits.length) {
  console.log(`✗ "${symbol}" 在 src${includeTests ? "/test" : ""} 中未找到`);
  console.log("  若你确信它存在，先怀疑搜索路径是否覆盖到了目标文件。");
  process.exit(1);
}

console.log(`✓ "${symbol}" 命中 ${hits.length} 处：\n`);
const shown = hits.slice(0, 12);
for (const h of shown) {
  console.log(`  ${h.file}:${h.line}`);
  console.log(`    ${h.text.slice(0, 100)}`);
}
if (hits.length > shown.length) {
  console.log(`  … 另有 ${hits.length - shown.length} 处`);
}
process.exit(0);
