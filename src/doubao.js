import { DoubaoMvpError, ErrorCode } from "./errors.js";
import { isSilentlyDropped, noFirstTokenWindowMs } from "./no-first-token.js";
import { hasStoredStorageState } from "./security/storage-state.js";
import { canonicalizeUrl, domainFromUrl, isExternalSourceUrl } from "./url.js";

const ANSWER_SELECTOR = [
  ".md-box-root",
  '[class*="md-box-root"]',
  '[data-testid="message_text_content"]',
  '[data-testid="message_content"]',
  ".flow-markdown-body",
].join(", ");

const SOURCE_BLOCK_SELECTOR = '[data-plugin-identifier*="block_type:10025"]';
const CITATION_SIGNAL = /搜索\s*(\d+)\s*个关键词[，,、\s]*参考\s*(\d+)\s*篇资料/;
const PLACEHOLDER_ANSWERS = new Set([
  "思考中",
  "生成中",
  "加载中",
  "正在生成",
  "正在思考",
  "稍等片刻",
  "正在查询",
]);

function normalizeText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function allowedDoubaoUrl(raw) {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host === "doubao.com" || host === "www.doubao.com";
  } catch {
    return false;
  }
}

async function firstVisibleEditable(page) {
  // 2026-10-05 实测：豆包把输入框从 textarea 换成 tiptap/ProseMirror 的
  // contenteditable div，而 data-testid="chat_input_input" 现在挂在一个**不可编辑的
  // 容器**上。原列表第一条命中该容器，isEditable() 为false 就整条链放弃，
  // 于是 fill 卡在 "waiting for element to be editable" —— 输入框定位失败连带
  // 发送按钮不出现（它只在有内容时才渲染），最终报 DOUBAO_SUBMISSION_FAILED。
  //
  // 因此把真正可编辑的编辑器本体排在最前，并把容器 testid 降级为兜底。
  const selectors = [
    '.tiptap.ProseMirror[contenteditable="true"]',
    '[contenteditable="true"][role="textbox"]',
    'textarea[placeholder*="发消息"]',
    'textarea[placeholder*="输入"]',
    'div[role="textbox"]',
    'textarea',
    '[contenteditable="true"]',
    '[data-testid="chat_input_input"]',
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = Math.min(await locator.count(), 20);
    for (let index = count - 1; index >= 0; index -= 1) {
      const candidate = locator.nth(index);
      const visible = await candidate.isVisible().catch(() => false);
      const editable = await candidate.isEditable().catch(() => false);
      if (visible && editable) return candidate;
    }
  }
  return null;
}

// composer 出现的最长等待：冷启动首屏需完整下载并执行前端 JS。
// 通过 ONEGL_COMPOSER_WAIT_MS 可调，下限 1000ms。
const COMPOSER_WAIT_MS = (() => {
  const raw = process.env.ONEGL_COMPOSER_WAIT_MS;
  if (raw == null || raw === "") return 30_000;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1_000 ? parsed : 30_000;
})();

async function waitForTextbox(page, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const box = await firstVisibleEditable(page);
    if (box) return box;
    await page.waitForTimeout(500);
  }
  return null;
}

export async function openDoubao(page, config) {
  try {
    await page.goto(config.doubaoUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
  } catch (error) {
    if (!allowedDoubaoUrl(page.url())) {
      throw new DoubaoMvpError(
        ErrorCode.NETWORK_ERROR,
        `Failed to open Doubao: ${error instanceof Error ? error.message : String(error)}`,
        { url: page.url() },
        { cause: error },
      );
    }
  }

  if (!allowedDoubaoUrl(page.url())) {
    throw new DoubaoMvpError(
      ErrorCode.PAGE_CHANGED,
      `Unexpected host after navigation: ${page.url()}`,
    );
  }

  // 先给一个固定的水合下限（保留原有行为），再条件等待 composer 真正挂载。
  //
  // 原因（实测 2026-09-18）：page.goto 用 waitUntil="domcontentloaded"，
  // 返回时 document.readyState 仍为 interactive，composer 尚未挂载
  // （composerCount=0，inspectSession 返回 state="unknown"）；
  // 实测约 1.5s 后才出现第一个可见 textarea。此前只等固定 1200ms，
  // 冷启动（新 context + 空缓存）路径必然踩空，导致下游
  // front-end-guard 的 fail-closed 判定抛 PAGE_CHANGED。
  //
  // 超时不抛错：下游 front-end-guard 已有明确的 fail-closed 分支，
  // 这里只负责「让页面有机会加载完」，不改变错误语义。
  await page.waitForTimeout(1_200);
  const composer = await waitForTextbox(page, COMPOSER_WAIT_MS);
  if (!composer) {
    console.warn(
      `[doubao] composer 未在 ${COMPOSER_WAIT_MS}ms 内出现，交由 front-end preflight 判定`,
    );
  }
}

/**
 * 豆包匿名面开关。
 *
 * 平台本身允许匿名访问：2026-09-20 实测（见 inspectSession 里的 cookie 清单）用全新 context
 * 打开 www.doubao.com 时页面正常加载、下发了 CSRF 令牌、`flow_cur_user_sec_id` 是空串占位 ——
 * 也就是说「没登录」但「能用」。此前 OneGl 把它判成 login_required 是**我们的要求**，不是平台
 * 的要求：判定写死了 `textbox && loggedIn` 才算 healthy。
 *
 * 打开后行为与千问那条匿名通道一致：不吃账号额度（`isCredentialFreeSurface` 会返回 true），
 * 可以并发开多个浏览器槽位，登录态不再必需。
 *
 * 默认关。开启前必须实测确认匿名首页确实能把问题问出去 —— 若平台在提交时才拦（登录墙出现在
 * 生成阶段），失败会落在 LOGIN_REQUIRED 上，而豆包的失败同样是 no-retry。
 */
const DOUBAO_ANONYMOUS_ENV = "ONEGL_DOUBAO_ANONYMOUS";

export function doubaoAnonymousEnabled() {
  const raw = String(process.env[DOUBAO_ANONYMOUS_ENV] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * 这个会话算不算可用。
 *
 * @param {object} options
 * @param {boolean} options.anonymous 匿名面：允许在没有登录态的情况下使用 composer
 */
export async function inspectSession(page, { anonymous = false } = {}) {
  return page.evaluate((anonymousSurface) => {
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    const visibleText = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], .semi-modal, .modal, [role="alert"]')]
      .filter(visible)
      .map((el) => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean);

    const hasVisible = (selector) =>
      [...document.querySelectorAll(selector)].some(visible);

    const routerLogin =
      window._ROUTER_DATA?.loaderData?.chat_layout?.userSetting?.data?.is_login;
    // ★ 登录判据必须看「值」，不能只看 cookie 是否存在（2026-09-20 实测修正）。
    //
    // 匿名访问（全新 context、无任何 storage state）www.doubao.com 时实测：
    //   passport_csrf_token         = "d733ee7e…"（32 位）—— CSRF 令牌，未登录也会下发
    //   passport_csrf_token_default = 同上
    //   flow_cur_user_sec_id        = ""（空串占位）
    //   x-tt-multi-sids             = 不存在
    //   flow_multi_user_sec_info    = 不存在
    //
    // 旧判据只要 cookie「名字存在」就算已登录 ⇒ 匿名也 loggedIn=true ⇒
    // remote-auth 首次轮询即判 healthy，会话从 starting 直接跳 connected，
    // 二维码永远不会出现，用户根本无从扫码（GEO 侧表现为「未扫码也绑定成功」）。
    //
    // 因此：CSRF 令牌一律不承载登录语义；会话 cookie 必须取到非空值才算数。
    //
    // 下面这份「正向名单」里的名字，在同一次匿名探针的 10 个 cookie 中
    // 全部不存在（只有 flow_cur_user_sec_id 存在但为空串），
    // 因此把它们纳入判据不会重新引入匿名误判，只会让真实登录更容易被识别。
    const cookieEntries = document.cookie
      .split(";")
      .map((entry) => {
        const index = entry.indexOf("=");
        return index < 0
          ? { name: entry.trim().toLowerCase(), value: "" }
          : {
              name: entry.slice(0, index).trim().toLowerCase(),
              value: entry.slice(index + 1).trim(),
            };
      })
      .filter((entry) => entry.name.length > 0);
    const cookieValue = (name) =>
      cookieEntries.find((entry) => entry.name === name)?.value ?? "";
    const SESSION_COOKIES = [
      "x-tt-multi-sids",
      "flow_multi_user_sec_info",
      "flow_cur_user_sec_id",
      "sessionid",
      "sessionid_ss",
      "sid_tt",
    ];
    // 只有真正承载用户会话的 cookie 才算登录凭证，且必须非空。
    const passportCookie = SESSION_COOKIES.some(
      (name) => cookieValue(name).length > 0,
    );
    let loginStorage = false;
    try {
      loginStorage = Boolean(localStorage.getItem("flow_web_login_changed"));
    } catch {
      loginStorage = false;
    }
    const loggedIn = routerLogin === true || passportCookie || loginStorage;

    const captcha =
      hasVisible('iframe[src*="captcha"], iframe[src*="verify"], iframe[src*="rmc"], input[placeholder*="验证码"], input[aria-label*="验证码"]') ||
      visibleText.some((text) => /人机验证|完成安全验证|滑动验证|拖动滑块/.test(text));

    const explicitLogin =
      routerLogin === false ||
      visibleText.some((text) => /扫码登录|请登录后使用|登录后继续|登录以解锁更多功能/.test(text));

    const loginButton = [...document.querySelectorAll("button")].some(
      (button) => visible(button) && (button.innerText || button.textContent || "").trim() === "登录",
    );

    const accessRestricted =
      !captcha &&
      !explicitLogin &&
      visibleText.some((text) => /访问异常|访问受限|服务异常|当前访问人数过多|网络不给力/.test(text));

    const textbox = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')].some(visible);

    if (captcha) return { state: "verification_required", routerLogin, loggedIn, loginButton, textbox };

    // ── 匿名面 ────────────────────────────────────────────────────────────────
    // 实测（2026-09-24）：匿名打开 www.doubao.com/chat 时，页面**右上角常驻一个「登录」按钮**，
    // 而 composer 完全可用 —— 提问后拿到了 952 字的正常答案，全程没有登录墙。所以那个按钮是
    // 「平台提供一个登录入口」，不是「不登录就不让你用」。若沿用登录态的判定顺序（有登录按钮
    // 且未登录 ⇒ login_required），匿名面会在**功能完全正常**的情况下被判成需要登录，
    // 改造就等于没做 —— 第一次探测正是这个结果。
    //
    // 真正的 login 墙特征不是那个按钮，而是「既有登录按钮、又给不出可输入的 composer」。
    // captcha / access_restricted 在匿名面照旧拦：那是平台明确拒绝，与登录与否无关。
    if (anonymousSurface) {
      if (accessRestricted) return { state: "access_restricted", routerLogin, loggedIn, loginButton, textbox };
      if (textbox) return { state: "healthy", routerLogin, loggedIn, loginButton, textbox };
      return { state: "unknown", routerLogin, loggedIn, loginButton, textbox };
    }

    if (explicitLogin && !loggedIn) return { state: "login_required", routerLogin, loggedIn, loginButton, textbox };
    if (loginButton && !loggedIn) return { state: "login_required", routerLogin, loggedIn, loginButton, textbox };
    if (accessRestricted) return { state: "access_restricted", routerLogin, loggedIn, loginButton, textbox };
    if (textbox && loggedIn) return { state: "healthy", routerLogin, loggedIn, loginButton, textbox };
    return { state: "unknown", routerLogin, loggedIn, loginButton, textbox };
  }, anonymous);
}

export async function waitForManualLogin(page, config) {
  const deadline = Date.now() + config.loginTimeoutMs;
  let healthyPolls = 0;
  let lastNavigationAt = Date.now();
  while (Date.now() < deadline) {
    let state;
    try {
      state = await inspectSession(page);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Execution context was destroyed|navigation|Target closed|Cannot find context/i.test(message)) {
        healthyPolls = 0;
        lastNavigationAt = Date.now();
        await page.waitForTimeout(1_000);
        continue;
      }
      throw error;
    }
    if (state.state === "healthy") {
      if (Date.now() - lastNavigationAt < 2_000) {
        healthyPolls = 0;
      } else {
        healthyPolls += 1;
        if (healthyPolls >= 2) return state;
      }
    } else {
      healthyPolls = 0;
    }
    await page.waitForTimeout(2_000);
  }

  throw new DoubaoMvpError(
    ErrorCode.LOGIN_REQUIRED,
    `Manual login was not completed within ${config.loginTimeoutMs} ms`,
  );
}

export async function requireHealthySession(page, config) {
  // 匿名面允许在没有登录态的情况下使用 composer。开关来自环境而非 config：config 由
  // loadConfig 生成，那里没有平台专属概念，而这是豆包独有的运行模式。
  const anonymous = doubaoAnonymousEnabled();
  const settleMs = Math.min(config.timeoutMs, 30_000);
  const deadline = Date.now() + settleMs;
  let state = await inspectSession(page, { anonymous });
  while (state.state === "unknown" && Date.now() < deadline) {
    await page.waitForTimeout(config.pollMs);
    state = await inspectSession(page, { anonymous });
  }
  if (state.state === "healthy") return state;

  const hadStoredAuth = anonymous ? false : await hasStoredStorageState(config);
  if (state.state === "verification_required") {
    throw new DoubaoMvpError(
      ErrorCode.VERIFICATION_REQUIRED,
      "Doubao requires a verification challenge to be completed manually.",
      state,
    );
  }
  if (state.state === "access_restricted") {
    throw new DoubaoMvpError(
      ErrorCode.ACCESS_RESTRICTED,
      "Doubao reports access restrictions or an abnormal access state.",
      state,
    );
  }
  if (state.state === "login_required") {
    throw new DoubaoMvpError(
      hadStoredAuth ? ErrorCode.SESSION_EXPIRED : ErrorCode.LOGIN_REQUIRED,
      anonymous
        ? "匿名面的豆包挂出了登录要求（通常是匿名额度用尽）。需要人工确认是继续匿名还是改用登录态。"
        : hadStoredAuth
          ? "The saved Doubao session is no longer authenticated. Run the auth command again."
          : "Doubao login is required. Run the auth command first.",
      state,
    );
  }

  throw new DoubaoMvpError(
    ErrorCode.PAGE_CHANGED,
    "Doubao page loaded but the chat input could not be confirmed.",
    state,
  );
}

async function clickFirstVisible(locator) {
  const count = Math.min(await locator.count(), 10);
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) {
      await candidate.click();
      return true;
    }
  }
  return false;
}

export async function startCleanConversation(page, config) {
  const candidates = [
    page.getByRole("button", { name: "新对话", exact: true }),
    page.getByText("新对话", { exact: true }),
  ];

  let clicked = false;
  for (const candidate of candidates) {
    try {
      if (await clickFirstVisible(candidate)) {
        clicked = true;
        break;
      }
    } catch {
      // Try the next semantic candidate.
    }
  }

  if (!clicked && /\/chat\/[^/?#]+/.test(page.url())) {
    await openDoubao(page, config);
  }

  const box = await waitForTextbox(page, 30_000);
  if (!box) {
    throw new DoubaoMvpError(
      ErrorCode.PAGE_CHANGED,
      "Could not find the Doubao chat input after starting a clean conversation.",
    );
  }

  await box.fill("").catch(async () => {
    await box.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.press("Backspace");
  });
  await page.waitForTimeout(400);

  const settleMs = config?.conversationSettleMs ?? 15_000;
  const resetConfirmed = await waitForEmptyConversation(page, settleMs);
  return { clickedNewConversation: clicked, resetConfirmed };
}

async function waitForEmptyConversation(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let stableEmptyPolls = 0;
  while (Date.now() < deadline) {
    const candidates = await answerCandidates(page);
    if (candidates.length === 0) {
      stableEmptyPolls += 1;
      if (stableEmptyPolls >= 2) return true;
    } else {
      stableEmptyPolls = 0;
    }
    await page.waitForTimeout(400);
  }
  return false;
}

async function answerTexts(page) {
  return page.evaluate((selector) => {
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };

    return [...document.querySelectorAll(selector)]
      .filter(visible)
      .map((element) => (element.innerText || element.textContent || "").trim())
      .filter(Boolean);
  }, ANSWER_SELECTOR);
}

async function answerCandidates(page) {
  return page.evaluate((selector) => {
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };

    const isUserBubble = (element) => {
      let node = element;
      for (let depth = 0; node && depth < 6; depth += 1) {
        const tokens = String(node.getAttribute("class") || "").split(/\s+/);
        if (tokens.includes("justify-end")) return true;
        node = node.parentElement;
      }
      return false;
    };

    return [...document.querySelectorAll(selector)]
      .filter(visible)
      .map((element) => ({
        text: (element.innerText || element.textContent || "").trim(),
        isUser: isUserBubble(element),
        streaming: element.getAttribute("data-streaming") === "true",
      }))
      .filter((item) => item.text);
  }, ANSWER_SELECTOR);
}

const IN_PROGRESS_STEP = /正在(搜索|思考|生成|查询|读取|分析|整理|执行|编写|获取|规划|联网)/;

async function isGenerating(page) {
  return page.evaluate((inProgressSource) => {
    const inProgress = new RegExp(inProgressSource);
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };

    const stopControl = [...document.querySelectorAll('button, [role="button"]')]
      .filter(visible)
      .some((element) => {
        const text = `${element.getAttribute("aria-label") || ""} ${element.innerText || element.textContent || ""}`;
        return /停止生成|停止回答|停止/.test(text);
      });
    if (stopControl) return true;

    return [...document.querySelectorAll("div, span, p, li")]
      .filter((element) => element.childElementCount === 0)
      .filter(visible)
      .some((element) => {
        const text = (element.textContent || "").trim();
        return text.length > 0 && text.length <= 40 && inProgress.test(text);
      });
  }, IN_PROGRESS_STEP.source);
}

async function detectProviderError(page) {
  const text = await page.locator("body").innerText().catch(() => "");
  if (/请求过于频繁|操作频繁|稍后再试|达到.*上限|额度.*不足/.test(text)) {
    return { code: ErrorCode.RATE_LIMITED, message: "Doubao appears to be rate limited." };
  }
  if (/网络不给力|网络异常|服务异常|请求失败/.test(text)) {
    return { code: ErrorCode.NETWORK_ERROR, message: "Doubao reports a network or service error." };
  }
  return null;
}

/**
 * 回读校验专用的归一化：**删除所有空白**。
 *
 * 为什么不能直接用 normalizeText：它被两处语义不同的用途共用。
 *   - 回读校验（fillVerifiedPrompt）：要容忍编辑器排版
 *   - 比对回答是否新增（waitForSubmissionConfirmation）：必须严格，
 *     回答里的换行是有意义的段落分隔，抹掉会把两段回答误判成同一段
 * 所以校验走这个独立的函数，normalizeText 保持原样。
 *
 * 豆包的 composer 可能是 `div[role="textbox"]` 或 `[contenteditable="true"]`
 * （选择器链第 4、5 位），而 readEditableValue 对它们读 textContent ——
 * 富文本渲染长文本时会插入换行节点，这些节点会进入 textContent。
 * 于是回读拿到 "A\nB" 而期望值是 "AB"，用 normalizeText 会误判失败。
 *
 * 千问已经因为同类问题踩过一次（Slate 插软换行 → 折叠成空格 → 多一个空格）。
 * 判定只该关心「输入框里是不是我那句话」，不关心排版；
 * 真填错内容仍会被抓住 —— 错的文字删空白删不掉。
 */
const normalizeForVerification = (value) => String(value ?? "").replace(/\s+/g, "");

/** 诊断用：保留单行可读形式，不参与判定。 */
const normalizeForLog = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

async function readEditableValue(locator) {
  return locator.evaluate((element) => {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return element.value;
    }
    return element.textContent || "";
  });
}

/**
 * 清空输入框。
 *
 * fill() 之前必须显式清空：豆包的 composer 在上一问发送后仍可能保留文本
 * （或渲染出上一问的幽灵节点），而 fill() 对选错的 contenteditable 会静默不生效，
 * 于是「重试三次」其实是同样的三次失败。
 *
 * 两种形态都要处理：
 *   - input/textarea：直接改 value 并派发 input 事件
 *   - contenteditable：全选后 delete，并清掉可能残留的子节点
 *
 * 派发 input 事件是关键 —— 豆包的发送按钮靠 input 事件启用，
 * 只改 value 不派发的话按钮仍是灰的。
 */
async function clearEditable(locator) {
  await locator.evaluate((element) => {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.value = "";
    } else {
      // contenteditable：全选 + 删除能触发浏览器的原生清空与 input 事件
      const selection = element.ownerDocument.getSelection();
      const range = element.ownerDocument.createRange();
      range.selectNodeContents(element);
      selection?.removeAllRanges();
      selection?.addRange(range);
      element.textContent = "";
    }
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function tryClickSend(page) {
  // `send_message` 是 2026-09-30 在 run_b142_i8 的 page.html 里实测到的当前 testid。
  //
  // 之前四个选择器（`chat_input_send_button` / `flow-end-msg-send` / 两条 aria|title）
  // 在同一份快照里**一次都没出现** —— 豆包改版后发送控件换了 testid，于是
  // tryClickSend 恒返回 false、全部落到 Enter 回退分支。代价是可量化的：
  // Enter 提交不触发引用区渲染，实测引用率 7.1%（1/14），而按钮提交是 78.6%（11/14）。
  //
  // 旧名字**故意保留**：它们不匹配时只是多一轮 locator 查询，代价可忽略；
  // 而删掉它们会让下一次豆包再改版时连回退的机会都没有 —— 回车至少还能把问题发出去。
  // 顺序即优先级：当前实测名字在前。
  const selectors = [
    '[data-testid="send_message"]',
    'button[data-testid="chat_input_send_button"]',
    '#flow-end-msg-send',
    'button[aria-label*="发送"]',
    'button[title*="发送"]',
  ];
  // 2026-10-05 实测：新版发送按钮是**输入之后异步渲染**的 —— tiptap 状态更新之后
  // 才挂上 button[data-testid="chat_input_send_button"]。fillVerifiedPrompt 回读确认
  // 文本已就位只等700ms，按钮常常还没渲染，于是这里一次查不到就直接 false，
  // 落进 Enter 分支（引用率 7.1% vs 按钮 78.6%）。
  //
  // 所以改成「在窗口内反复找」，而不是查一次就放弃。找不到才退Enter —— Enter 仍保留，
  // 下一次豆包再改版时至少能把问题发出去。
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector);
      const count = Math.min(await locator.count(), 10);
      for (let index = count - 1; index >= 0; index -= 1) {
        const button = locator.nth(index);
        if (
          (await button.isVisible().catch(() => false)) &&
          (await button.isEnabled().catch(() => false))
        ) {
          try {
            await button.click({ timeout: 5_000 });
            return true;
          } catch {
            // 点不到（可能被弹层遮挡）就继续等下一轮，不立刻放弃。
          }
        }
      }
    }
    await page.waitForTimeout(300);
  }
  return false;
}

async function waitForSubmissionConfirmation(page, prompt, baselineAnswers, baselineUrl = "") {
  const deadline = Date.now() + 20_000;
  const target = normalizeText(prompt);
  while (Date.now() < deadline) {
    const confirmed = await page.evaluate((needle) => {
      const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const candidates = [
        ...document.querySelectorAll('[class*="whitespace-pre-wrap"], [data-testid*="send_message"], [data-testid*="user"]'),
      ];
      return candidates.some((element) => norm(element.innerText || element.textContent || "") === needle);
    }, target);
    if (confirmed) return true;

    if ((await answerTexts(page)).length > baselineAnswers.length) return true;
    if (await isGenerating(page)) return true;

    // 2026-10-05 实测：新版豆包提交后立刻把 /chat/ 换成 /chat/local_<id>，
    // 这是「问题确实被平台接收」最直接的证据，比等气泡或回答都快且可靠。
    if (baselineUrl && page.url() !== baselineUrl) return true;

    await page.waitForTimeout(400);
  }
  return false;
}

async function fillVerifiedPrompt(page, prompt, attempts = 3) {
  // expected 与 actual 必须用同一个归一化，否则一边删空白一边不删 → 永远不相等 → 100% 误判
  const expected = normalizeForVerification(prompt);
  let lastFailure = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const box = await waitForTextbox(page, 15_000);
    if (!box) {
      lastFailure = { reason: "chat-input-unavailable" };
    } else {
      try {
        // 先显式清空再填。
        //
        // 实测：批次 69 里 i28 分配的题目是「越城区颈肩腰腿调理哪家手法好？」，
        // 而输入框里回读到的是 i17 的题目「绍兴越城区的推拿店，手法和价格要怎么比较
        // 才靠谱？」—— 两者都是本批次的合法题目，说明是**上一问的残留**，
        // 不是平台判定的「损坏文本」。
        //
        // 而原来的重试是 `box.fill(prompt)` 重复三次：fill() 对 contenteditable
        // 若选错元素会静默不生效，三次都是同样的旧文本，重试毫无意义 ——
        // 于是这一问必然失败。实测该批次 50 问里 25 问失败，
        // 其中 16 问是这条路径，失败率因此高达 50%。
        await clearEditable(box);
        await box.fill(prompt);
        const actual = normalizeForVerification(await readEditableValue(box));
        if (actual !== expected) {
          lastFailure = {
            reason: "verification-mismatch",
            expected: normalizeForLog(prompt),
            actual: normalizeForLog(await readEditableValue(box).catch(() => "")),
          };
        } else {
          await page.waitForTimeout(700);
          const settled = normalizeForVerification(await readEditableValue(box).catch(() => ""));
          if (settled === expected) return box;
          lastFailure = {
            reason: "text-lost-after-fill",
            expected: normalizeForLog(prompt),
            settled: normalizeForLog(await readEditableValue(box).catch(() => "")),
          };
        }
      } catch (error) {
        lastFailure = {
          reason: "fill-failed",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
    if (attempt < attempts) await page.waitForTimeout(1_000);
  }

  if (lastFailure?.reason === "chat-input-unavailable") {
    throw new DoubaoMvpError(ErrorCode.PAGE_CHANGED, "Doubao chat input is not available.", {
      ...lastFailure,
      // 输入框都没出现，提问显然没有送出去 —— 这是「可以安全再给一次机会」的依据。
      // 判据落在这一位上而不是错误码上，见 safety.js 的 canRetryOutcome。
      promptSubmitted: false,
    });
  }

  throw new DoubaoMvpError(
    ErrorCode.SUBMISSION_FAILED,
    "Prompt input verification failed; submission was stopped to avoid sending corrupted text.",
    // 同上：这条路径是**发送被主动拦下**（填进去的内容校验不过，根本没点发送），
    // 提问从未到达平台，所以重试是安全的。
    //
    // 注意 `SUBMISSION_FAILED` 还覆盖另一种情况 —— submitPrompt 里
    // 「send action fired but the page did not confirm submission」，那条**可能已经提交**，
    // 所以它**不带**这一位。两者靠 promptSubmitted 区分，而不是靠错误码：
    // canRetryOutcome 对 RESUBMIT_UNSAFE_CODES 要求这一位恰好为 false 才放行。
    { ...(lastFailure ?? {}), promptSubmitted: false },
  );
}

/**
 * 关掉豆包的推广弹窗。
 *
 * 实测依据（失败样本 run_b69_i8 的 page.html + dom-observation.json，2026-09-25）：
 * 匿名面跑几条之后会弹出「下载豆包电脑版 免费领取 30 天订阅」的**全屏** dialog，
 * `role="dialog"` 且带 `aria-label="关闭"` 的关闭按钮，覆盖整个视口。
 *
 * 它造成的症状是 `send action fired but the page did not confirm submission` ——
 * 输入与发送被弹窗遮住，点击落到了遮罩上。而同一份观测里
 * `sessionSignals.login=false`、`accessRestricted=false`、`captcha=false`、
 * `visibleTextboxCount=1`，说明**匿名面本身完全正常**。
 *
 * 所以「豆包匿名面有额度限制/会话不稳」这个结论是错的：挡住我们的一直是这个推广弹窗。
 * 采集器其实早就观测到了它（dom-observation 的 `modalTexts` 里记着全文），只是没人关掉。
 *
 * 只关推广弹窗，不误伤功能性弹窗（引用面板、确认框）—— 判据取弹窗自身文案。
 */
const PROMO_DIALOG_TEXT = /下载豆包电脑版|免费领取\s*30\s*天|立即下载/;

/**
 * 关掉「下载电脑版 / 领 30 天订阅」这类推广弹窗。
 *
 * 2026-10-05 实测：弹窗**间歇出现**（同一次探测里有时有、有时没有），且新版
 * radix dialog 的遮罩（dialogMask-*）会拦截指针事件 —— 输入框点不动、
 * Playwright 的 click 反复 retry 直到超时。因此必须主动清掉。
 *
 * <p>关闭方式两路兜底：先找关闭按钮（新版是 data-slot="dialog-close"），
 * 找不到就按 Escape —— radix dialog 响应 Escape，且不需要定位具体控件，
 * 对改版更耐受。两条都失败才算放弃。</p>
 */
async function dismissPromoDialog(page) {
  const closed = await page
    .evaluate((pattern) => {
      const re = new RegExp(pattern);
      const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
      let count = 0;
      for (const dialog of document.querySelectorAll('[role="dialog"]')) {
        const text = norm(dialog.innerText).slice(0, 200);
        if (!re.test(text)) continue;
        const button =
          dialog.querySelector('[data-slot="dialog-close"]')
          ?? dialog.querySelector('button[aria-label="关闭"]')
          ?? dialog.querySelector('button[aria-label="close"]')
          ?? dialog.querySelector('[class*="closeButton"]');
        if (button) {
          button.click();
          count += 1;
        } else {
          count += 100; // 标记成「有弹窗但没找到按钮」，交给 Escape 兜底
        }
      }
      return count;
    }, PROMO_DIALOG_TEXT.source)
    .catch(() => 0);

  // 有弹窗却找不到关闭控件（或弹窗遮罩仍在）时用 Escape 收尾。
  let remaining = 0;
  try {
    remaining = await page.evaluate(() => document.querySelectorAll('[role="dialog"]').length);
  } catch {
    return closed > 0 ? 1 : 0;
  }
  if (remaining > 0) {
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(400);
    try {
      remaining = await page.evaluate(
        () => document.querySelectorAll('[role="dialog"]').length,
      );
    } catch {
      remaining = 0;
    }
  }
  return closed > 0 || remaining === 0 ? Math.max(closed, 1) : 0;
}

async function submitPrompt(page, prompt) {
  // 推广弹窗是全屏的，会挡住输入与发送；它会在采集过程中随时弹出，所以每次发送前都清一次。
  const dismissed = await dismissPromoDialog(page);
  if (dismissed > 0) await page.waitForTimeout(600);

  await fillVerifiedPrompt(page, prompt);

  const baselineAnswers = await answerTexts(page);
  const sentByButton = await tryClickSend(page);
  if (!sentByButton) {
    const fresh = await waitForTextbox(page, 10_000);
    if (fresh) {
      await fresh.press("Enter", { timeout: 5_000 }).catch(() => undefined);
    }
  }

  const baselineUrl = page.url();
  if (!(await waitForSubmissionConfirmation(page, prompt, baselineAnswers, baselineUrl))) {
    throw new DoubaoMvpError(
      ErrorCode.SUBMISSION_FAILED,
      "The send action fired but the page did not confirm submission. The MVP will not auto-resubmit to avoid duplicates.",
      { sentByButton },
    );
  }

  return { baselineAnswers, sentByButton };
}

/**
 * 提交后「一个字符都没出现」的容忍窗 —— 越过就判定这次请求被平台静默丢弃，提前退出。
 *
 * 180s 沿用千问的实测值（7 条样本的首字延迟 8/8/8/8/6/50/97 秒，取尾部 97s 的约 1.85 倍）。
 * 豆包自己还没有这份分布 —— **不要**按「豆包是流式、应该更快」这类直觉把它调小，
 * 等 `[doubao] first-token` 日志攒够样本再校准。判错的代价不可逆：被判死的那条提问已经提交，
 * 重跑就是重复提问。
 *
 * 判据本身与千问共用（`no-first-token.js`），只认「从未出现过答案」。
 */
const DOUBAO_FIRST_TOKEN_MS_DEFAULT = 180_000;

/**
 * 答案的最小可信长度。
 *
 * 平台开始流式输出时，DOM 里先出现的是「The」这种还没成句的片段。
 * 早先没有任何长度判据，于是 3 个字符的片段被当成完整答案 —— 状态判 success，
 * 品牌提及与引用统计全算在它头上。
 *
 * 阈值取 12：短于它的几乎都是流式开头的残片。实测正常豆包答案最短也有
 * 几十字符（"Paris is the capital of France." = 31），远高于 12。
 */
const MIN_ANSWER_CHARS = 12;

async function waitForAnswer(page, baselineAnswers, config) {
  const baseline = new Set(baselineAnswers.map(normalizeText));
  // 计时起点是 submitPrompt 刚返回的时刻：提交动作已经完成，前面的页面准备与随机延迟都不占这条预算。
  const submittedAt = Date.now();
  const deadline = submittedAt + config.timeoutMs;
  // 窗口不能超过预算本身，否则「提前退出」反而会晚于超时到达。
  const firstTokenWindowMs = Math.min(
    noFirstTokenWindowMs("ONEGL_DOUBAO_FIRST_TOKEN_MS", DOUBAO_FIRST_TOKEN_MS_DEFAULT),
    config.timeoutMs,
  );
  let best = "";
  let last = "";
  let stable = 0;
  // 第一个字符出现的时刻（相对 submittedAt）。null = 到现在一个字符都没出现过。
  let firstTokenMs = null;

  while (Date.now() < deadline) {
    if (!allowedDoubaoUrl(page.url())) {
      throw new DoubaoMvpError(
        ErrorCode.PAGE_CHANGED,
        `Doubao navigated to an unexpected host: ${page.url()}`,
      );
    }

    const providerError = await detectProviderError(page);
    if (providerError) {
      throw new DoubaoMvpError(providerError.code, providerError.message, {
        url: page.url(),
      });
    }

    const usable = (await answerCandidates(page)).filter(
      (item) =>
        !item.isUser &&
        !baseline.has(normalizeText(item.text)) &&
        !PLACEHOLDER_ANSWERS.has(normalizeText(item.text)),
    );
  // 过短的片段、徽标、欢迎语与控件文案都不是答案。
  //
  // 实测（2026-09-29，匿名面）：问「What is the boiling point of water…」之后
  // 只读到 3 个字符的 "The"，而 status 被判为 success。
  // 它通过了上面所有过滤（不是用户气泡、不在基线里、不是占位符），
  // 于是被当成完整答案 —— 品牌提及、引用统计、报告里的回答数全算在这 3 个字符上。
  //
  // 这与 ANSWER_NOT_FOUND 是同一类问题的近亲：那边是「一个字都没有」，
  // 这里是「有字但明显没写完」。两者都不该进库。
  const substantive = usable.filter(
    (item) => normalizeText(item.text).length >= MIN_ANSWER_CHARS,
  );
  const current = substantive.map((item) => normalizeText(item.text));
    const answer = current.at(-1) || "";
    const running = usable.some((item) => item.streaming) || (await isGenerating(page));

    if (answer.length > best.length) best = answer;
    // 零输出判据。best 是「见过的最长答案」，一旦非空就永久关闭这条路径（语义见 no-first-token.js）——
    // 页面重渲染让某次采样读到 0 不算「没答」。
    if (best.length > 0 && firstTokenMs === null) firstTokenMs = Date.now() - submittedAt;
    if (
      isSilentlyDropped({
        answerLength: best.length,
        firstTokenSeen: firstTokenMs !== null,
        waitedMs: Date.now() - submittedAt,
        windowMs: firstTokenWindowMs,
      })
    ) {
      // 与超时分开报：两者都是「没拿到答案」，但一个等多久都没用，一个是预算不够。
      // 混在一起就会重演 2026-09-26 那次误判（把零输出读成额度问题，然后去改配额而不是改判据）。
      throw new DoubaoMvpError(
        ErrorCode.ANSWER_NOT_FOUND,
        `豆包提交后 ${Math.round((Date.now() - submittedAt) / 1000)}s 内没有产出任何字符，`
          + `判定这次请求被平台静默丢弃，提前退出（不再空耗 ${Math.round(config.timeoutMs / 1000)}s 预算）。`,
        {
          stage: "generating",
          url: page.url(),
          promptSubmitted: true,
          answerSeen: 0,
          generating: running,
          waitedMs: Date.now() - submittedAt,
          firstTokenWindowMs,
          budgetMs: config.timeoutMs,
        },
      );
    }
    if (answer && answer === last) stable += 1;
    else stable = answer ? 1 : 0;
    last = answer;

    if (answer && !running && stable >= config.stablePolls) {
      await page.waitForTimeout(800);
      // 结构化的首字延迟日志：DOUBAO_FIRST_TOKEN_MS_DEFAULT 沿用千问的值，靠这条日志校准。
      console.log(
        `[doubao] first-token ${Math.round((firstTokenMs ?? 0) / 1000)}s`
          + ` | answer ${best.length} chars`
          + ` | total ${Math.round((Date.now() - submittedAt) / 1000)}s / budget ${Math.round(config.timeoutMs / 1000)}s`,
      );
      return answer;
    }

    await page.waitForTimeout(config.pollMs);
  }

  if (best) {
    throw new DoubaoMvpError(
      ErrorCode.TIMEOUT,
      "Doubao produced partial text but did not reach a stable completed state before timeout.",
      { partialAnswer: best },
    );
  }

  throw new DoubaoMvpError(
    ErrorCode.ANSWER_NOT_FOUND,
    `豆包在 ${Math.round(config.timeoutMs / 1000)}s 预算内没有产出任何字符。`,
    {
      stage: "generating",
      url: page.url(),
      promptSubmitted: true,
      answerSeen: 0,
      waitedMs: Date.now() - submittedAt,
      firstTokenWindowMs,
      budgetMs: config.timeoutMs,
    },
  );
}

async function sourceSnapshot(page, clickIfNeeded = false) {
  return page.evaluate(
    ({ answerSelector, sourceSelector, signalSource, clickIfNeeded }) => {
      const signal = new RegExp(signalSource);
      const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const httpLink = (href) => {
        try {
          const url = new URL(href, location.href);
          return /^https?:$/.test(url.protocol);
        } catch {
          return false;
        }
      };
      const linkRows = (root) =>
        [...root.querySelectorAll("a[href]")]
          .filter(visible)
          .map((anchor) => ({
            title: norm(anchor.innerText || anchor.getAttribute("aria-label") || anchor.title),
            url: anchor.href,
            marker: norm(anchor.innerText || ""),
          }))
          .filter((row) => httpLink(row.url));

      const isUserBubble = (element) => {
        let node = element;
        for (let depth = 0; node && depth < 6; depth += 1) {
          const tokens = String(node.getAttribute("class") || "").split(/\s+/);
          if (tokens.includes("justify-end")) return true;
          node = node.parentElement;
        }
        return false;
      };

      const answers = [...document.querySelectorAll(answerSelector)]
        .filter(visible)
        .filter((element) => !isUserBubble(element));
      const answer = answers.at(-1) || null;
      if (!answer) {
        return { sourceFound: false, answerFound: false, links: [], relations: [] };
      }

      const relationRows = [...answer.querySelectorAll("a[href]")]
        .filter(visible)
        .filter((anchor) => httpLink(anchor.href))
        .map((anchor) => ({
          url: anchor.href,
          marker: norm(anchor.innerText || anchor.getAttribute("aria-label") || ""),
          answerText: norm(
            (anchor.closest("p, li, blockquote") || anchor.parentElement || anchor).innerText ||
              anchor.textContent ||
              "",
          ).slice(0, 800),
        }));

      /**
       * 判断引用块是否属于「本轮答案」。
       *
       * 唯一的硬约束：**块必须排在答案之前**。
       *
       * 2026-10-05 实测（fixture doubao-2026-10-05-cited）：引用块是答案的
       * 前置兄弟。旧代码向上爬祖先链时用 querySelectorAll 找后代，而祖先
       * 容器同时装着「本轮引用块」和「下一轮内容（用户追问的答案与它的引用块）」，
       * 于是 matches.length > 1 时 .at(-1) 会取到下一轮的块 —— 答案与引用错配。
       * 页面末尾的全局 .at(-1) 兜底有同样的问题。
       *
       * DOM 规范方向（实测核对过 raw 值 4 / 2）：
       *   element.compareDocumentPosition(answer) 返回 FOLLOWING
       *     <=> answer 在 element 之后 <=> element 在 answer 之前。
       */
      const precedesAnswer = (element, anchorNode) =>
        Boolean(element.compareDocumentPosition(anchorNode) & Node.DOCUMENT_POSITION_FOLLOWING);

      /**
       * 取答案之前最近的引用块。祖先链与全局兜底共用的唯一定位规则。
       */
      const pickBlock = (scope) => {
        let best = null;
        for (const element of scope.querySelectorAll(sourceSelector)) {
          if (!visible(element)) continue;
          if (!precedesAnswer(element, anchorNodeFor)) continue;
          if (!signal.test(norm(element.innerText || element.textContent || ""))) continue;
          best = element; // 文档序后出现的更近，直接覆盖即得最近者
        }
        return best;
      };

      const anchorNodeFor = answer;

      /**
       * 唯一的选块判据。祖先链与全局兜底都必须过这一关。
       *
       * 保留唯一的例外：块嵌在答案节点内部（部分渲染形态），此时方向判据不适用。
       */
      const acceptable = (element) => {
        if (anchorNodeFor.contains(element)) return true;
        return precedesAnswer(element, anchorNodeFor);
      };

      let source = null;
      let scope = answer;
      for (let depth = 0; depth < 8 && scope; depth += 1) {
        const matches = [...scope.querySelectorAll(sourceSelector)]
          .filter(visible)
          .filter((element) => signal.test(norm(element.innerText || element.textContent || "")))
          .filter(acceptable);
        if (matches.length) {
          source = matches.at(-1);
          break;
        }
        scope = scope.parentElement;
      }

      // 祖先链没定案时，在整个文档里按同一判据取答案之前最近的块。
      if (!source) source = pickBlock(document);

      if (!source) {
        return {
          sourceFound: false,
          answerFound: true,
          links: relationRows.map(({ url, marker }) => ({ url, marker, title: marker })),
          relations: relationRows,
        };
      }

      const sourceText = norm(source.innerText || source.textContent || "");
      const match = sourceText.match(signal);
      const expectedCount = match ? Number(match[2]) : null;
      const links = linkRows(source);
      let clicked = false;

      if (clickIfNeeded && Number.isInteger(expectedCount) && links.length < expectedCount) {
        const triggers = [
          ...source.querySelectorAll(
            '[data-copy-ignore].cursor-pointer, [data-copy-ignore][class*="cursor-pointer"], [role="button"], button',
          ),
        ].filter(visible);
        const trigger =
          triggers.find((element) => signal.test(norm(element.innerText || element.textContent || ""))) ||
          triggers[0];
        if (trigger instanceof HTMLElement) {
          trigger.click();
          clicked = true;
        }
      }

      return {
        sourceFound: true,
        answerFound: true,
        sourceText,
        expectedCount,
        links,
        relations: relationRows,
        clicked,
      };
    },
    {
      answerSelector: ANSWER_SELECTOR,
      sourceSelector: SOURCE_BLOCK_SELECTOR,
      signalSource: CITATION_SIGNAL.source,
      clickIfNeeded,
    },
  );
}

async function overlayLinks(page) {
  return page.evaluate(() => {
    const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const httpLink = (href) => {
      try {
        return /^https?:$/.test(new URL(href, location.href).protocol);
      } catch {
        return false;
      }
    };

    const overlays = [
      ...document.querySelectorAll(
        '[role="dialog"], [aria-modal="true"], [class*="popover"], [class*="reference"]',
      ),
    ]
      .filter(visible)
      .map((root) => ({
        text: norm(root.innerText || root.textContent || ""),
        links: [...root.querySelectorAll("a[href]")]
          .filter(visible)
          .map((anchor) => ({
            title: norm(anchor.innerText || anchor.getAttribute("aria-label") || anchor.title),
            url: anchor.href,
            marker: norm(anchor.innerText || ""),
          }))
          .filter((row) => httpLink(row.url)),
      }))
      .filter((item) => item.links.length > 0);

    return overlays;
  });
}

function normalizeCitationRows(rows, relations) {
  const relationMap = new Map();
  for (const relation of relations || []) {
    const canonical = canonicalizeUrl(relation.url);
    if (canonical && !relationMap.has(canonical)) relationMap.set(canonical, relation);
  }

  const seen = new Set();
  const citations = [];
  let rawLinkCount = 0;
  const discarded = { internalHost: 0, unparseable: 0, duplicate: 0 };
  for (const row of rows || []) {
    rawLinkCount += 1;
    if (!isExternalSourceUrl(row.url)) {
      discarded.internalHost += 1;
      continue;
    }
    const canonicalUrl = canonicalizeUrl(row.url);
    if (!canonicalUrl) {
      discarded.unparseable += 1;
      continue;
    }
    if (seen.has(canonicalUrl)) {
      discarded.duplicate += 1;
      continue;
    }
    seen.add(canonicalUrl);
    const relation = relationMap.get(canonicalUrl) || null;
    citations.push({
      title: row.title || null,
      url: row.url,
      canonicalUrl,
      domain: domainFromUrl(canonicalUrl),
      sourcePosition: citations.length + 1,
      citationMarker: relation?.marker || row.marker || null,
      answerText: relation?.answerText || null,
      sourceType: "visible",
      capturedFrom: "DOM",
      visibleToUser: true,
      relationStatus: relation ? "matched" : "unresolved",
    });
  }
  return {
    citations,
    rawLinkCount,
    uniqueUrlCount: citations.length,
    discardReasons: discarded,
  };
}

function emptyCounts() {
  return {
    expected: null,
    domLinks: 0,
    rawLinks: 0,
    captured: 0,
    discarded: { internalHost: 0, unparseable: 0, duplicate: 0 },
    diagnostic: "reference-count-mismatch:0/unknown",
  };
}

function buildCounts(meta, { expected, domLinks }) {
  const counts = {
    expected: Number.isInteger(expected) ? expected : null,
    domLinks: Number(domLinks) || 0,
    rawLinks: meta.rawLinkCount,
    captured: meta.uniqueUrlCount,
    discarded: meta.discardReasons,
  };
  const breakdown = [];
  if (counts.discarded.internalHost) breakdown.push(`internal:${counts.discarded.internalHost}`);
  if (counts.discarded.duplicate) breakdown.push(`duplicate:${counts.discarded.duplicate}`);
  if (counts.discarded.unparseable) breakdown.push(`unparseable:${counts.discarded.unparseable}`);
  const expectedLabel = counts.expected ?? "unknown";
  counts.diagnostic =
    `reference-count-mismatch:${counts.captured}/${expectedLabel}` +
    (breakdown.length ? ` (raw:${counts.rawLinks} ${breakdown.join(" ")})` : ` (raw:${counts.rawLinks})`);
  return counts;
}

export async function extractVisibleCitations(page) {
  let snapshot = await sourceSnapshot(page, false);
  if (!snapshot.answerFound) {
    // 走到这里时答案文本其实已经拿到（executeDoubaoPrompt 里 waitForAnswer 先行
    // 保证了这一点，否则早就抛错返回了）。这里的 answerFound 来自 sourceSnapshot
    // 的另一次独立 DOM 查询，会因渲染时序/虚拟列表回收而偶发落空。
    // 因此不再判 parse_failed —— 判失败等于用一次二次查询的抖动否决已经成功的抓取。
    // 归为 none_visible（本轮无可见来源），诊断串保留以便区分。
    return {
      state: "none_visible",
      expectedCount: null,
      citations: [],
      diagnostics: ["answer-root-not-found"],
      counts: emptyCounts(),
      selectorUsed: null,
      sourceBlockFound: false,
      answerRootFound: false,
    };
  }

  if (!snapshot.sourceFound) {
    const meta = normalizeCitationRows(snapshot.links, snapshot.relations);
    const citations = meta.citations;
    return {
      state: citations.length ? "found" : "none_visible",
      expectedCount: citations.length ? citations.length : 0,
      citations,
      diagnostics: citations.length ? ["inline-link-fallback"] : [],
      counts: buildCounts(meta, {
        expected: citations.length,
        domLinks: snapshot.links.length,
      }),
      selectorUsed: "inline-links",
      sourceBlockFound: false,
      answerRootFound: true,
    };
  }

  if (
    Number.isInteger(snapshot.expectedCount) &&
    snapshot.links.length < snapshot.expectedCount
  ) {
    snapshot = await sourceSnapshot(page, true);
    if (snapshot.clicked) await page.waitForTimeout(700);
    snapshot = await sourceSnapshot(page, false);
  }

  let rows = snapshot.links || [];
  let overlayAmbiguous = false;
  if (
    Number.isInteger(snapshot.expectedCount) &&
    rows.length !== snapshot.expectedCount
  ) {
    const overlays = await overlayLinks(page);
    if (overlays.length === 1) rows = overlays[0].links;
    else if (overlays.length > 1) overlayAmbiguous = true;
  }

  const meta = normalizeCitationRows(rows, snapshot.relations);
  const citations = meta.citations;
  const counts = buildCounts(meta, {
    expected: Number.isInteger(snapshot.expectedCount) ? snapshot.expectedCount : null,
    domLinks: snapshot.links.length,
  });

  const diagnostics = [];
  if (overlayAmbiguous) diagnostics.push("reference-overlay-ambiguous");
  if (!Number.isInteger(snapshot.expectedCount)) diagnostics.push("reference-count-signal-missing");

  if (counts.expected !== null && counts.expected > 0 && counts.captured !== counts.expected) {
    diagnostics.push(counts.diagnostic);
    if (!Number.isInteger(snapshot.expectedCount)) diagnostics.push("reference-count-unknown");
  }

  if (Number.isInteger(snapshot.expectedCount) && snapshot.expectedCount === 0) {
    return {
      state: "none_visible",
      expectedCount: 0,
      citations: [],
      diagnostics,
      counts,
      selectorUsed: SOURCE_BLOCK_SELECTOR,
      sourceBlockFound: true,
      answerRootFound: true,
    };
  }

  if (Number.isInteger(snapshot.expectedCount) && citations.length !== snapshot.expectedCount) {
    // 引用数量与页面标注不一致不再判失败。
    // 原因是这个比对本身依赖豆包 DOM 的标注数量（expectedCount），而该标注会随
    // 页面改版、懒加载、「展开全部引用」交互时序而漂移；实测 15/20 这类差异属于
    // 抓取口径差异而非抓取失败——回答正文与可见链接都已经完整拿到。
    // 继续把它判成 parse_failed 会让整条检测链路在最后一步被否决，属于用校验否定了
    // 已经成功的采集结果。这里降级为 found 并保留 diagnostic 供分析。
    return {
      state: citations.length ? "found" : "none_visible",
      expectedCount: snapshot.expectedCount,
      citations,
      diagnostics,
      counts,
      selectorUsed: SOURCE_BLOCK_SELECTOR,
      sourceBlockFound: true,
      answerRootFound: true,
    };
  }

  if (!citations.length) {
    // 同上：来源区块里没解析出可见链接，只是「没抓到引用」，不是「抓取失败」。
    // 回答正文仍然有效，因此归为 none_visible，保留诊断串。
    return {
      state: "none_visible",
      expectedCount: snapshot.expectedCount ?? null,
      citations: [],
      diagnostics: [...diagnostics, "reference-block-has-no-source-links"],
      counts,
      selectorUsed: SOURCE_BLOCK_SELECTOR,
      sourceBlockFound: true,
      answerRootFound: true,
    };
  }

  return {
    state: "found",
    expectedCount: snapshot.expectedCount ?? citations.length,
    citations,
    diagnostics,
    counts,
    selectorUsed: SOURCE_BLOCK_SELECTOR,
    sourceBlockFound: true,
    answerRootFound: true,
  };
}

export function assertFreshConversation(conversation, currentUrl = null) {
  if (conversation?.resetConfirmed === true) return;
  throw new DoubaoMvpError(
    ErrorCode.CONVERSATION_RESET_FAILED,
    "Could not confirm a fresh, empty conversation; the prompt was deliberately not sent.",
    {
      clickedNewConversation: conversation?.clickedNewConversation ?? false,
      resetConfirmed: conversation?.resetConfirmed ?? null,
      currentUrl,
      promptSubmitted: false,
      stage: "pre-submit",
    },
  );
}

function withExecutionStage(error, { stage, promptSubmitted }) {
  const details =
    error?.details && typeof error.details === "object" && !Array.isArray(error.details)
      ? { ...error.details }
      : {};
  if (details.stage === undefined) details.stage = stage;
  if (details.promptSubmitted === undefined) details.promptSubmitted = promptSubmitted;
  if (error instanceof DoubaoMvpError) {
    error.details = details;
    return error;
  }
  return new DoubaoMvpError(
    ErrorCode.UNKNOWN_ERROR,
    error instanceof Error ? error.message : String(error),
    details,
    error instanceof Error ? { cause: error } : undefined,
  );
}

export async function executeDoubaoPrompt(page, prompt, config) {
  let submitting = false;
  try {
    await requireHealthySession(page, config);
    const conversation = await startCleanConversation(page, config);
    assertFreshConversation(conversation, page.url());
    await requireHealthySession(page, config);

    submitting = true;
    const submission = await submitPrompt(page, prompt);
    const answer = await waitForAnswer(page, submission.baselineAnswers, config);
    const citationResult = await extractVisibleCitations(page);

    if (!submission.sentByButton) {
      // 2026-10-05 实测（批次 157–163，44 个 run）：
      //   enter_key  提交 13 个 → 引用 0 条，13/13 全零
      //   按钮提交 21 个     → 引用 11–39 条
      // 零引用那批的 citationDiagnostics 全是 reference-block-not-found +
      // inline-links-empty：豆包根本没渲染引用区，不是抓取漏了。
      //
      // 答案文本有效，但「0 引用」在这里是提交手段的产物。记成 success 会让
      // 报告把采集缺陷读成「该问题/品牌不被豆包引用」——比缺一条数据更有害。
      // 所以按失败抛出，走重试；重试通常就落到按钮上了（tryClickSend 会等 8s
      // 等异步渲染的按钮）。答案仍然写进 partialAnswer，不浪费已经跑出来的内容。
      throw new DoubaoMvpError(
        ErrorCode.SUBMIT_DEGRADED,
        "提问通过回车提交，未触发豆包渲染引用区；该结果的引用维度不可用，请重试以走发送按钮。",
        {
          stage: "generating",
          url: page.url(),
          promptSubmitted: true,
          submissionMethod: "enter_key",
          answerChars: answer.length,
          partialAnswer: answer,
          citationState: citationResult.state,
          citationCount: citationResult.citations.length,
        },
      );
    }

    return {
      answer,
      citations: citationResult.citations,
      citationState: citationResult.state,
      expectedCitationCount: citationResult.expectedCount,
      citationDiagnostics: citationResult.diagnostics,
      citationCounts: citationResult.counts ?? null,
      citationSelectorUsed: citationResult.selectorUsed ?? null,
      submissionMethod: submission.sentByButton ? "send_button" : "enter_key",
      conversationReset: conversation.clickedNewConversation,
      conversationResetConfirmed: conversation.resetConfirmed,
      currentUrl: page.url(),
    };
  } catch (error) {
    throw withExecutionStage(error, {
      stage: submitting ? "submit" : "pre-submit",
      promptSubmitted: submitting,
    });
  }
}
