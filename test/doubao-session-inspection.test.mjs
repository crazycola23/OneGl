/**
 * 登录态判定回归测试。
 *
 * 背景（2026-09-20 实测）：匿名（全新 context、无任何 storage state）访问
 * www.doubao.com 时，页面仍会下发
 *   passport_csrf_token         = "d733ee7e577672f0600b4753836fd1c9"（32 位）
 *   passport_csrf_token_default = 同上
 *   flow_cur_user_sec_id        = ""（空串占位）
 * 而真正承载会话的 x-tt-multi-sids / flow_multi_user_sec_info 并不存在。
 *
 * 旧判据只看 cookie「名字是否存在」⇒ 匿名也 loggedIn=true ⇒
 * remote-auth 首次轮询即判 healthy，会话从 starting 直接跳 connected，
 * 二维码永远不出现（GEO 侧表现为「未扫码也绑定成功」）。
 *
 * 本文件用真实的 cookie 串驱动 inspectSession 的内联逻辑，锁死三件事：
 *   1. 匿名 cookie 不得判为已登录（防止上述旁路复现）；
 *   2. 真实会话 cookie / routerLogin 仍判为已登录（防止误杀正常采集）；
 *   3. 只有 CSRF 令牌且 sec_id 为空时，即使有输入框也不得判 healthy。
 *
 * 注：inspectSession 的代码通过 page.evaluate 序列化到浏览器执行，
 * 因此这里直接调用 callback 并注入最小 DOM 替身，跑的是源码本身而非副本。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { inspectSession } from "../src/doubao.js";

// 2026-09-20 在 onegl-app-worker-1 容器内用全新无凭证 context 实测所得。
const ANONYMOUS_COOKIE =
  "passport_csrf_token=d733ee7e577672f0600b4753836fd1c9; " +
  "passport_csrf_token_default=d733ee7e577672f0600b4753836fd1c9; " +
  "flow_cur_user_sec_id=";

const LOGGED_IN_COOKIE =
  "passport_csrf_token=d733ee7e577672f0600b4753836fd1c9; " +
  "passport_csrf_token_default=d733ee7e577672f0600b4753836fd1c9; " +
  "flow_cur_user_sec_id=MS4wLjABAAAAexampleSessionId; " +
  "x-tt-multi-sids=%22abc%22";

function makeElement(tag, extras = {}) {
  return {
    tagName: tag.toUpperCase(),
    innerText: "",
    textContent: "",
    style: {},
    getBoundingClientRect: () => ({ width: 100, height: 40 }),
    ...extras,
  };
}

/**
 * 构造最小 DOM 替身，让 inspectSession 的 evaluate 回调可以在 Node 里被执行。
 * @param {object} options
 * @param {string} options.cookie            document.cookie 原文
 * @param {boolean|undefined} options.routerLogin  window._ROUTER_DATA ... is_login
 * @param {string|null} options.loginStorage localStorage flow_web_login_changed
 * @param {boolean} options.textbox          是否存在可见输入框
 * @param {string[]} options.dialogTexts    可见弹窗/提示文本（用于验证码、限制态）
 */
function withFakeDom(options, callback) {
  const {
    cookie = "",
    routerLogin = undefined,
    loginStorage = null,
    textbox = true,
    dialogTexts = [],
  } = options;

  const previous = {
    HTMLElement: globalThis.HTMLElement,
    document: globalThis.document,
    window: globalThis.window,
    getComputedStyle: globalThis.getComputedStyle,
    localStorage: globalThis.localStorage,
  };

  class FakeHTMLElement {}
  globalThis.HTMLElement = FakeHTMLElement;

  const dialogs = dialogTexts.map((text) => {
    const element = makeElement("div");
    Object.setPrototypeOf(element, FakeHTMLElement.prototype);
    element.innerText = text;
    element.textContent = text;
    return element;
  });

  const textboxElement = makeElement("textarea");
  Object.setPrototypeOf(textboxElement, FakeHTMLElement.prototype);

  globalThis.document = {
    cookie,
    querySelectorAll(selector) {
      if (selector.includes("textarea")) return textbox ? [textboxElement] : [];
      if (selector.includes("dialog") || selector.includes("modal") || selector.includes("alert")) {
        return dialogs;
      }
      return [];
    },
  };

  globalThis.window = {
    _ROUTER_DATA:
      routerLogin === undefined
        ? undefined
        : { loaderData: { chat_layout: { userSetting: { data: { is_login: routerLogin } } } } },
  };
  globalThis.getComputedStyle = () => ({ display: "block", visibility: "visible", opacity: "1" });
  globalThis.localStorage = { getItem: () => loginStorage };

  try {
    return callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
}

async function inspect(options) {
  const page = {
    async evaluate(callback) {
      return withFakeDom(options, callback);
    },
  };
  return inspectSession(page);
}

test("匿名访问的 cookie 不得被判为已登录（旧的按名判定会误判）", async () => {
  const state = await inspect({ cookie: ANONYMOUS_COOKIE, textbox: true });
  assert.equal(state.loggedIn, false, "未登录页面不应判定 loggedIn");
  assert.notEqual(state.state, "healthy", "未登录页面不得判为 healthy");
});

test("只有 CSRF 令牌且 sec_id 为空时不得判 healthy（二维码必须能出现）", async () => {
  // remote-auth 只在 state === healthy 时直接 finish connected；
  // 这里必须是非 healthy，会话才会进入 waiting_for_login。
  const state = await inspect({ cookie: ANONYMOUS_COOKIE, textbox: true });
  assert.equal(state.state, "unknown");
});

test("真实会话 cookie 非空时仍判为已登录，正常采集不受影响", async () => {
  const state = await inspect({ cookie: LOGGED_IN_COOKIE, textbox: true });
  assert.equal(state.loggedIn, true);
  assert.equal(state.state, "healthy");
});

test("仅 flow_cur_user_sec_id 非空也算已登录", async () => {
  const state = await inspect({
    cookie: "flow_cur_user_sec_id=MS4wLjABAAAAonlySecId",
    textbox: true,
  });
  assert.equal(state.loggedIn, true);
  assert.equal(state.state, "healthy");
});

test("ByteDance 通用会话 cookie（sid_tt / sessionid）非空也算已登录", async () => {
  // 这几个名字在同一次匿名探针的 10 个 cookie 里都不存在，
  // 纳入判据只为让真实登录更容易被识别，不会重新引入匿名误判。
  for (const name of ["sid_tt", "sessionid", "sessionid_ss"]) {
    const state = await inspect({ cookie: `${name}=abc123`, textbox: true });
    assert.equal(state.loggedIn, true, `${name} 非空应判为已登录`);
  }
});

test("routerLogin=true 时不依赖 cookie 亦判为已登录（防止误杀）", async () => {
  const state = await inspect({ cookie: "", routerLogin: true, textbox: true });
  assert.equal(state.loggedIn, true);
  assert.equal(state.state, "healthy");
});

test("routerLogin=false 显式未登录时判为 login_required", async () => {
  const state = await inspect({ cookie: ANONYMOUS_COOKIE, routerLogin: false, textbox: true });
  assert.equal(state.state, "login_required");
});
