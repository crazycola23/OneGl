import { stat } from "node:fs/promises";
import { DoubaoMvpError, ErrorCode } from "./errors.js";
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

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
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

  await page.waitForTimeout(1_200);
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

    if (captcha) return { state: "verification_required", routerLogin, loginButton, textbox };
    if (explicitLogin || loginButton) return { state: "login_required", routerLogin, loginButton, textbox };
    if (accessRestricted) return { state: "access_restricted", routerLogin, loginButton, textbox };
    if (textbox) return { state: "healthy", routerLogin, loginButton, textbox };
    return { state: "unknown", routerLogin, loginButton, textbox };
  });
}

export async function waitForManualLogin(page, config) {
  const deadline = Date.now() + config.loginTimeoutMs;
  let healthyPolls = 0;
  while (Date.now() < deadline) {
    const state = await inspectSession(page);
    if (state.state === "healthy") {
      healthyPolls += 1;
      if (healthyPolls >= 2) return state;
    } else {
      healthyPolls = 0;
      if (state.state === "verification_required") {
        // The user can solve the challenge in the open browser; keep waiting.
      }
    }
    await page.waitForTimeout(2_000);
  }

  throw new DoubaoMvpError(
    ErrorCode.LOGIN_REQUIRED,
    `Manual login was not completed within ${config.loginTimeoutMs} ms`,
  );
}

export async function requireHealthySession(page, config) {
  // Doubao is an SPA that reports `unknown` while it boots, and a cold browser can need
  // several seconds before the composer renders. Wait that gap out instead of reporting
  // a page change; definitive login/verification states are still reported immediately.
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
    page.getByRole("button", { name: "新工作任务", exact: true }),
    page.getByText("新工作任务", { exact: true }),
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

  // Confirm the conversation really is empty before the prompt runs. Clicking 新对话
  // only reports that a click happened; the SPA may still be swapping the composer.
  // A run whose answer was shaped by leftover history would silently corrupt the
  // mention-rate statistic, so this has to be verified rather than assumed.
  const settleMs = config?.conversationSettleMs ?? 15_000;
  const resetConfirmed = await waitForEmptyConversation(page, settleMs);
  return { clickedNewConversation: clicked, resetConfirmed };
}

async function waitForEmptyConversation(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const candidates = await answerCandidates(page);
    if (!candidates.some((item) => !item.isUser)) return true;
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

// Doubao renders the user's own message bubble with the same `.md-box-root` class it
// uses for assistant answers, so a bare selector match makes the extractor mistake the
// submitted prompt for the answer. User bubbles are right-aligned inside a `justify-end`
// row, while an assistant message that is still being written carries
// `data-streaming="true"`. Both facts were verified against the live DOM.
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

// An in-flight progress step such as "正在搜索相关资料 ›" is the reliable signal that a
// task-mode turn is still running. Matching is restricted to leaf elements with short
// text so a container whose subtree merely contains the phrase cannot trigger it.
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
          // Doubao re-renders the composer, so after the first turn in a session the
          // resolved button node can go stale and the click never lands. Treat that as
          // "not sent" so submitPrompt falls back to the Enter-key path.
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

// Doubao re-renders the composer (notably when switching conversations, and in task
// mode), which detaches the textarea node in the middle of fill(). Retry with a fresh
// node instead of failing the run, while still never sending unverified text.
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
          // Doubao can swap the composer right after fill and silently drop the text.
          // Re-read after a short settle so we never click send on an empty box.
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
    // Re-resolve the composer first: the node captured by the fill may already be
    // detached, and pressing Enter on a stale handle just times out.
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
    // The "停止生成" button that isGenerating looks for is not rendered on current
    // Doubao builds, so the streaming attribute on the answer node is what actually
    // tells us the answer is still being written.
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
      const external = (href) => {
        try {
          const url = new URL(href, location.href);
          if (!/^https?:$/.test(url.protocol)) return false;
          return !/doubao\.com|bytedance|zijieapi|byteimg|feiliao/i.test(url.hostname);
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
          .filter((row) => external(row.url));

      // Same rule as answerCandidates: the user's own bubble shares `.md-box-root`,
      // so it must not be mistaken for the answer root.
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
        .filter((anchor) => external(anchor.href))
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
    const external = (href) => {
      try {
        const url = new URL(href, location.href);
        return (
          /^https?:$/.test(url.protocol) &&
          !/doubao\.com|bytedance|zijieapi|byteimg|feiliao/i.test(url.hostname)
        );
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
          .filter((row) => external(row.url)),
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
  for (const row of rows || []) {
    if (!isExternalSourceUrl(row.url)) continue;
    const canonicalUrl = canonicalizeUrl(row.url);
    if (!canonicalUrl || seen.has(canonicalUrl)) continue;
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
  return citations;
}

export async function extractVisibleCitations(page) {
  let snapshot = await sourceSnapshot(page, false);
  if (!snapshot.answerFound) {
    return {
      state: "parse_failed",
      expectedCount: null,
      citations: [],
      diagnostics: ["answer-root-not-found"],
    };
  }

  if (!snapshot.sourceFound) {
    const inline = normalizeCitationRows(snapshot.links, snapshot.relations);
    return {
      state: inline.length ? "found" : "none_visible",
      expectedCount: inline.length ? inline.length : 0,
      citations: inline,
      diagnostics: inline.length ? ["inline-link-fallback"] : [],
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

  const citations = normalizeCitationRows(rows, snapshot.relations);
  const diagnostics = [];
  if (overlayAmbiguous) diagnostics.push("reference-overlay-ambiguous");
  if (!Number.isInteger(snapshot.expectedCount)) diagnostics.push("reference-count-signal-missing");

  if (Number.isInteger(snapshot.expectedCount)) {
    if (snapshot.expectedCount === 0) {
      return {
        state: "none_visible",
        expectedCount: 0,
        citations: [],
        diagnostics,
      };
    }
    if (citations.length !== snapshot.expectedCount) {
      diagnostics.push(`reference-count-mismatch:${citations.length}/${snapshot.expectedCount}`);
      return {
        state: "parse_failed",
        expectedCount: snapshot.expectedCount,
        citations,
        diagnostics,
      };
    }
  }

  if (!citations.length) {
    return {
      state: "parse_failed",
      expectedCount: snapshot.expectedCount ?? null,
      citations: [],
      diagnostics: [...diagnostics, "reference-block-has-no-source-links"],
    };
  }

  return {
    state: "found",
    expectedCount: snapshot.expectedCount ?? citations.length,
    citations,
    diagnostics,
  };
}

/**
 * Fail closed on the conversation reset.
 *
 * This is an execution-stage gate, not a reporting filter: an answer produced on top of
 * a previous conversation measures P(mention | prompt + history), which is not the
 * quantity this tool exists to measure. Excluding such runs later would still mean the
 * prompt was sent, so the check has to happen before submit.
 */
export function assertFreshConversation(conversation, currentUrl = null) {
  if (conversation?.resetConfirmed === true) return;
  throw new DoubaoMvpError(
    ErrorCode.CONVERSATION_RESET_FAILED,
    "Could not confirm a fresh, empty conversation; the prompt was deliberately not sent.",
    {
      clickedNewConversation: conversation?.clickedNewConversation ?? false,
      resetConfirmed: conversation?.resetConfirmed ?? null,
      currentUrl,
    },
  );
}

export async function executeDoubaoPrompt(page, prompt, config) {
  await requireHealthySession(page, config);
  const conversation = await startCleanConversation(page, config);
  assertFreshConversation(conversation, page.url());
  await requireHealthySession(page, config);
  const submission = await submitPrompt(page, prompt);
  const answer = await waitForAnswer(page, submission.baselineAnswers, config);
  const citationResult = await extractVisibleCitations(page);

  return {
    answer,
    citations: citationResult.citations,
    citationState: citationResult.state,
    expectedCitationCount: citationResult.expectedCount,
    citationDiagnostics: citationResult.diagnostics,
    submissionMethod: submission.sentByButton ? "send_button" : "enter_key",
    conversationReset: conversation.clickedNewConversation,
    conversationResetConfirmed: conversation.resetConfirmed,
    currentUrl: page.url(),
  };
}
