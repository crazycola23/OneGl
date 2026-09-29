// 钉住 check-imports.mjs 的两个性质，缺一不可：
//   1) 真有未声明的包时必须失败 —— 只会说 OK 的检查器等于没有检查器
//   2) 合法代码不能误报 —— 误报一次之后靠人肉排除，比一开始就不误报更贵
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { test } from "node:test";

const SCRIPT = "tools/check-imports.mjs";
const PROBE = "src/__probe-check-imports.mjs";

function run() {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}

test("未声明的包会被检出（非零退出）", () => {
  writeFileSync(PROBE, 'import x from "definitely-not-a-real-package";\nexport default x;\n');
  try {
    const { code, out } = run();
    assert.equal(code, 1, "未声明的包必须让检查失败");
    assert.match(out, /definitely-not-a-real-package/);
  } finally {
    if (existsSync(PROBE)) unlinkSync(PROBE);
  }
});

test("死链的相对导入会被检出", () => {
  writeFileSync(PROBE, 'import x from "./__no-such-module.js";\nexport default x;\n');
  try {
    const { code, out } = run();
    assert.equal(code, 1, "解析不到的相对导入必须让检查失败");
    assert.match(out, /unresolved-relative/);
  } finally {
    if (existsSync(PROBE)) unlinkSync(PROBE);
  }
});

test("真实 src 干净：既无未声明包也无死链", () => {
  const { code, out } = run();
  assert.equal(code, 0, "真实代码应当通过检查，实际输出：\n" + out);
});

test("注释里的 from \"...\" 不会被当成 import", () => {
  // qianwen-web.js 有一句真实注释：// ... from "risk control", ...
  // 曾经的检查器把它报成未声明包，误报一次就要人去排除。
  const src = readFileSync("src/providers/qianwen-web.js", "utf8");
  assert.match(src, /from "risk control"/, "这条注释应当仍在，防止有人顺手改掉回归场景");
  const { code, out } = run();
  assert.equal(code, 0, "注释不该触发误报，实际输出：\n" + out);
});
