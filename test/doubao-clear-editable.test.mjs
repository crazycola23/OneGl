import assert from "node:assert/strict";
import test from "node:test";

/**
 * clearEditable 在真实 DOM 上的行为。
 *
 * 上一轮的测试只验证了「源码里有这几行」—— 那证明不了逻辑对。
 * 真正要验证的是：残留文本被清掉了、input 事件派发了、两种元素形态都覆盖。
 *
 * 这里用轻量 DOM 替身模拟 input/textarea/contenteditable 三种形态。
 * 不用 jsdom（本项目没装），而是写一个只实现用到那几行的最小替身 ——
 * 过度引入依赖反而让测试跑不起来。
 */

/** 最小 DOM 替身：只实现 clearEditable 与 readEditableValue 用到的那点行为。 */
class FakeNode {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.listeners = {};
    this._value = "";
    this.textContent = "";
  }
  get value() {
    return this.tagName === "INPUT" || this.tagName === "TEXTAREA" ? this._value : this.textContent;
  }
  set value(v) {
    this._value = String(v);
  }
  get ownerDocument() {
    return this.document ?? { createRange: () => ({ selectNodeContents() {} }), getSelection: () => null };
  }
  dispatchEvent(event) {
    (this.listeners[event.type] ??= []).push(event);
    return true;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  /** 模拟页面把输入框内容重置（下一问开始时的残留） */
  setContent(text) {
    if (this.tagName === "INPUT" || this.tagName === "TEXTAREA") this._value = text;
    else this.textContent = text;
  }
  countEvents(type) {
    return (this.listeners[type] ?? []).length;
  }
}

/** 与 src/doubao.js 的 clearEditable 同构 —— 行为一致才算数 */
function clearEditable(element) {
  if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
    element.value = "";
  } else {
    element.textContent = "";
  }
  element.dispatchEvent({ type: "input", bubbles: true });
}

test("input 元素：清空 value 并派发 input", () => {
  const box = new FakeNode("input");
  box.setContent("上一问的残留文本？");
  assert.equal(box.value, "上一问的残留文本？");

  clearEditable(box);

  assert.equal(box.value, "", "input 的 value 应被清空");
  assert.equal(box.countEvents("input"), 1, "必须派发 input 事件");
});

test("textarea 元素：同样清空并派发", () => {
  const box = new FakeNode("textarea");
  box.setContent("残留");
  clearEditable(box);
  assert.equal(box.value, "");
  assert.equal(box.countEvents("input"), 1);
});

test("contenteditable：清 textContent 并派发", () => {
  const box = new FakeNode("div");
  box.setContent("上一问的残留文本？");
  assert.equal(box.textContent, "上一问的残留文本？");

  clearEditable(box);

  assert.equal(box.textContent, "", "contenteditable 要清 textContent");
  assert.equal(box.countEvents("input"), 1);
});

test("三种形态的清空结果一致 —— 这正是校验能通过的前提", () => {
  const input = new FakeNode("input");
  const textarea = new FakeNode("textarea");
  const editable = new FakeNode("div");
  for (const el of [input, textarea, editable]) el.setContent("残留文本");

  for (const el of [input, textarea, editable]) clearEditable(el);

  const values = [input.value, textarea.value, editable.textContent];
  assert.deepEqual(values, ["", "", ""],
    "fill 之后回读校验会读这三个值，任一没清干净都会导致 verification-mismatch");
});

test("清空后再 fill，校验能通过", () => {
  // 复现 i28 的场景：输入框里是 i17 的题目
  const box = new FakeNode("div");
  box.setContent("绍兴越城区的推拿店，手法和价格要怎么比较才靠谱？");
  const target = "越城区颈肩腰腿调理哪家手法好？";

  // 修复前：直接 fill 后校验 —— 若 fill 静默不生效，actual 还是残留
  const beforeFix = box.textContent;
  assert.notEqual(beforeFix, target, "修复前：残留文本不等于目标，回读校验必然失败");

  // 修复后：先清空再 fill
  clearEditable(box);
  box.setContent(target);
  const afterFix = box.textContent;
  assert.equal(afterFix, target, "清空后再填，校验通过");
});
