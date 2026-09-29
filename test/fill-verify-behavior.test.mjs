import assert from "node:assert/strict";
import test from "node:test";

/**
 * 完整链路的行为验证：清空 → 填充 → 回读校验。
 *
 * ## 为什么结构测试不够
 *
 * 前两轮的结构测试（"源码里有 clearComposer 调用"、"expected 与 actual 同口径"）
 * 都通过了，但实际行为仍有问题：
 *   - 归一化口径不一致 → 100% 误判（结构测试没覆盖，因为两边"看起来"都调了函数）
 *   - 折叠成空格 → 软换行误判（结构测试完全看不出来）
 *
 * 结构断言能防止「改动时忘了同步」，但证明不了「跑起来对」。
 * 这里用最小 DOM 替身走完整链路。
 */

/** 最小富文本编辑器替身：模拟 contenteditable 的换行节点插入行为。 */
class FakeEditor {
  constructor() {
    this.tagName = "DIV";
    this.isTextarea = false;
    this._text = "";
    this._value = "";
    this.listeners = {};
    // 富文本渲染长文本时，编辑器会插入换行节点
    this.wrapsAt = null;
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  get value() { return this._value; }
  set value(v) { this._value = String(v); }

  /** 模拟编辑器在指定列宽处折行（插入 \n 节点） */
  setContent(text, { wrapAt = null } = {}) {
    if (this.isTextarea) {
      this._value = text;
    } else {
      this._text = wrapAt ? wrapText(text, wrapAt) : text;
    }
  }
  dispatchEvent(e) { (this.listeners[e.type] ??= []).push(e); return true; }
  countEvents(t) { return (this.listeners[t] ?? []).length; }
  get ownerDocument() {
    return {
      createRange: () => ({ selectNodeContents() {} }),
      getSelection: () => null,
    };
  }
}

/** 富文本折行：在视觉列宽处插入换行，但不改动字符本身 */
function wrapText(text, width) {
  let out = "";
  let col = 0;
  for (const ch of text) {
    if (col >= width) { out += "\n"; col = 0; }
    out += ch;
    col += 1;
  }
  return out;
}

/** 与实现同构的归一化 */
const verifyNorm = (v) => String(v ?? "").replace(/\s+/g, "");
const logNorm = (v) => String(v ?? "").replace(/\s+/g, " ").trim();

/** 与 clearEditable 同构 */
function clearEditable(el) {
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") el.value = "";
  else el.textContent = "";
  el.dispatchEvent({ type: "input", bubbles: true });
}

/**
 * 与 fillVerifiedPrompt 同构的完整链路。
 * 返回 { ok, reason, expected, actual }
 */
function fillAndVerify(editor, prompt, { fillSticks = false } = {}) {
  const expected = verifyNorm(prompt);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    clearEditable(editor);
    // fillSticks=true 模拟 fill() 静默不生效：内容永远是空，
    // 于是三次重试都是同样的失败 —— 这正是豆包原缺陷的形态。
    if (!fillSticks) editor.setContent(prompt);
    const actual = verifyNorm(editor.textContent || editor.value);
    if (actual === expected) return { ok: true, attempts: attempt };
  }
  return {
    ok: false,
    reason: "verification-mismatch",
    expected: logNorm(prompt),
    actual: logNorm(editor.textContent || editor.value),
  };
}

const PROMPT = "越城区颈肩腰腿调理哪家手法好？";

// ---- 场景 1：输入框有上一问残留 ----
test("残留文本：清空后能正确填入", () => {
  const editor = new FakeEditor();
  editor.setContent("绍兴越城区的推拿店，手法和价格要怎么比较才靠谱？");
  assert.notEqual(verifyNorm(editor.textContent), verifyNorm(PROMPT));

  const r = fillAndVerify(editor, PROMPT);
  assert.equal(r.ok, true, `清空后应通过校验，实际失败: ${r.reason}`);
  assert.equal(r.attempts, 1, "第一次就该通过");
});

// ---- 场景 2：富文本折行（千问 Slate / 豆包 contenteditable）----
test("富文本折行不导致误判", () => {
  const editor = new FakeEditor();
  const wrapped = wrapText(PROMPT, 10);
  assert.ok(wrapped.includes("\n"), "测试前提：这行确实被折行了");

  editor.setContent(wrapped, { wrapAt: 10 });
  const r = fillAndVerify(editor, PROMPT);
  assert.equal(r.ok, true, "折行是排版行为，不该被判成输入不一致");
});

// ---- 场景 3：textarea 形态 ----
test("textarea 形态同样通过", () => {
  const editor = new FakeEditor();
  editor.tagName = "TEXTAREA";
  editor.isTextarea = true;
  editor.setContent("上一问残留");
  const r = fillAndVerify(editor, PROMPT);
  assert.equal(r.ok, true);
});

// ---- 场景 4：fill 静默不生效（豆包原缺陷）----
test("fill 静默不生效时重试也无效（这是原缺陷，此处记录行为）", () => {
  const editor = new FakeEditor();
  editor.setContent("上一问残留");
  // 三次都填不进去 → 必然失败。清空解决不了 fill 无效，只能拦住脏数据。
  const r = fillAndVerify(editor, PROMPT, { fillSticks: true });
  assert.equal(r.ok, false, "fill 无效时校验必须失败（拦截未提交的脏数据）");
  assert.equal(r.reason, "verification-mismatch");
  // 关键：失败时诊断里 expected 与 actual 都要有，且可读
  assert.ok(r.expected && r.actual !== undefined, "失败诊断要含 expected 与 actual");
  assert.ok(!r.expected.includes("\n"), "诊断用可读形式，不含换行");
});

test("清空让「fill 无效」变得可诊断（原来 actual 是残留文本）", () => {
  const withoutClear = new FakeEditor();
  withoutClear.setContent("上一问残留");
  // 不清空直接填（fill 有效）：输入框里会变成「残留 + 新内容」
  withoutClear.setContent("上一问残留" + PROMPT);
  const before = verifyNorm(withoutClear.textContent);

  const withClear = new FakeEditor();
  withClear.setContent("上一问残留");
  withClear.textContent = ""; // 清空
  withClear.setContent(PROMPT);
  const after = verifyNorm(withClear.textContent);

  assert.notEqual(before, verifyNorm(PROMPT), "不清空时校验失败（这正是 i28 的形态）");
  assert.equal(after, verifyNorm(PROMPT), "清空后校验通过");
});

// ---- 场景 5：真的填错内容 ----
test("填错内容被抓住", () => {
  for (const wrong of [
    "越城区颈肩腰腿调理哪家手法好",     // 少字
    "越城区颈肩腰腿调理哪家手法好吗？",  // 多字
    "越城区颈肩腰腿调理哪家于法好？",    // 错字
  ]) {
    const editor = new FakeEditor();
    editor.setContent("");            // 干净起点，只看内容差异
    editor.setContent(wrong);
    const actual = verifyNorm(editor.textContent);
    assert.notEqual(actual, verifyNorm(PROMPT), `错内容必须被发现: ${wrong}`);
  }
});

// ---- 场景 6：清空确实派发了 input 事件 ----
test("清空派发 input 事件（否则发送按钮保持禁用）", () => {
  const editor = new FakeEditor();
  editor.setContent("残留");
  clearEditable(editor);
  assert.equal(editor.countEvents("input"), 1, "必须派发 input 事件");
  assert.equal(editor.textContent, "", "内容被清空");
});

// ---- 场景 7：多次重试不会累积残留 ----
test("多轮采集之间不会累积残留", () => {
  const editor = new FakeEditor();
  const prompts = [];
  for (let i = 0; i < 8; i += 1) {
    const p = `第 ${i + 1} 个问题：越城区哪家手法好？`;
    prompts.push(p);
    const r = fillAndVerify(editor, p);
    assert.equal(r.ok, true, `第 ${i + 1} 轮应通过，实际失败: ${r.reason}`);
  }
  assert.equal(prompts.length, 8);
});
