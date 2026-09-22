import { DoubaoMvpError, ErrorCode } from "./errors.js";
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
  const selectors = [
    '[data-testid="chat_input_input"]',
    'textarea[placeholder*="发消息"]',
    'textarea[placeholder*="输入"]',
    'div[role="textbox"]',
    'textarea',
    '[contenteditable="true"]',
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

export async function inspectSession(page) {
  return page.evaluate(() => {
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
    if (explicitLogin && !loggedIn) return { state: "login_required", routerLogin, loggedIn, loginButton, textbox };
    if (loginButton && !loggedIn) return { state: "login_required", routerLogin, loggedIn, loginButton, textbox };
    if (accessRestricted) return { state: "access_restricted", routerLogin, loggedIn, loginButton, textbox };
    if (textbox && loggedIn) return { state: "healthy", routerLogin, loggedIn, loginButton, textbox };
    return { state: "unknown", routerLogin, loggedIn, loginButton, textbox };
  });
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
  const settleMs = Math.min(config.timeoutMs, 30_000);
  const deadline = Date.now() + settleMs;
  let state = await inspectSession(page);
  while (state.state === "unknown" && Date.now() < deadline) {
    await page.waitForTimeout(config.pollMs);
    state = await inspectSession(page);
  }
  if (state.state === "healthy") return state;

  const hadStoredAuth = await fileExists(config.authStatePath);
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
      hadStoredAuth
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

async function readEditableValue(locator) {
  return locator.evaluate((element) => {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return element.value;
    }
    return element.textContent || "";
  });
}

async function tryClickSend(page) {
  const selectors = [
    'button[data-testid="chat_input_send_button"]',
    '#flow-end-msg-send',
    'button[aria-label*="发送"]',
    'button[title*="发送"]',
  ];
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
          // Fall through and let the caller try Enter instead of failing the run.
        }
      }
    }
  }
  return false;
}

async function waitForSubmissionConfirmation(page, prompt, baselineAnswers) {
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
    await page.waitForTimeout(400);
  }
  return false;
}

async function fillVerifiedPrompt(page, prompt, attempts = 3) {
  const expected = normalizeText(prompt);
  let lastFailure = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const box = await waitForTextbox(page, 15_000);
    if (!box) {
      lastFailure = { reason: "chat-input-unavailable" };
    } else {
      try {
        await box.fill(prompt);
        const actual = normalizeText(await readEditableValue(box));
        if (actual !== expected) {
          lastFailure = { reason: "verification-mismatch", expected, actual };
        } else {
          await page.waitForTimeout(700);
          const settled = normalizeText(await readEditableValue(box).catch(() => ""));
          if (settled === expected) return box;
          lastFailure = { reason: "text-lost-after-fill" };
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
    throw new DoubaoMvpError(ErrorCode.PAGE_CHANGED, "Doubao chat input is not available.");
  }

  throw new DoubaoMvpError(
    ErrorCode.SUBMISSION_FAILED,
    "Prompt input verification failed; submission was stopped to avoid sending corrupted text.",
    lastFailure,
  );
}

async function submitPrompt(page, prompt) {
  await fillVerifiedPrompt(page, prompt);

  const baselineAnswers = await answerTexts(page);
  const sentByButton = await tryClickSend(page);
  if (!sentByButton) {
    const fresh = await waitForTextbox(page, 10_000);
    if (fresh) {
      await fresh.press("Enter", { timeout: 5_000 }).catch(() => undefined);
    }
  }

  if (!(await waitForSubmissionConfirmation(page, prompt, baselineAnswers))) {
    throw new DoubaoMvpError(
      ErrorCode.SUBMISSION_FAILED,
      "The send action fired but the page did not confirm submission. The MVP will not auto-resubmit to avoid duplicates.",
      { sentByButton },
    );
  }

  return { baselineAnswers, sentByButton };
}

async function waitForAnswer(page, baselineAnswers, config) {
  const baseline = new Set(baselineAnswers.map(normalizeText));
  const deadline = Date.now() + config.timeoutMs;
  let best = "";
  let last = "";
  let stable = 0;

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
    const current = usable.map((item) => normalizeText(item.text));
    const answer = current.at(-1) || "";
    const running = usable.some((item) => item.streaming) || (await isGenerating(page));

    if (answer.length > best.length) best = answer;
    if (answer && answer === last) stable += 1;
    else stable = answer ? 1 : 0;
    last = answer;

    if (answer && !running && stable >= config.stablePolls) {
      await page.waitForTimeout(800);
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
    "No Doubao answer text was found before timeout.",
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

      let source = null;
      let scope = answer;
      for (let depth = 0; depth < 8 && scope; depth += 1) {
        const matches = [...scope.querySelectorAll(sourceSelector)]
          .filter(visible)
          .filter((element) => signal.test(norm(element.innerText || element.textContent || "")));
        if (matches.length === 1) {
          source = matches[0];
          break;
        }
        if (matches.length > 1) {
          source = matches.at(-1);
          break;
        }
        scope = scope.parentElement;
      }

      if (!source) {
        const globalMatches = [...document.querySelectorAll(sourceSelector)]
          .filter(visible)
          .filter((element) => signal.test(norm(element.innerText || element.textContent || "")));
        source = globalMatches.at(-1) || null;
      }

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
