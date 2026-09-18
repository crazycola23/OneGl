import { inspectSession } from "./doubao.js";
import { DoubaoMvpError, ErrorCode } from "./errors.js";

// 等待 composer（输入框）出现后再做判定。
//
// 原因（实测 2026-09-18）：豆包 chat 页是客户端渲染，page.goto 以
// domcontentloaded 返回时 composer 尚未挂载（composerCount=0，
// inspectSession 返回 state="unknown"），实测约 1.5s 后才出现。
// preflight 的 fail-closed 语义要求「不能描述页面状态就不要提交」，
// 但「页面还没渲染完」不等于「页面状态未知」——必须先给它加载的机会，
// 否则会把正常的冷启动误判成 PAGE_CHANGED。
const PREFLIGHT_COMPOSER_WAIT_MS = (() => {
  const raw = process.env.ONEGL_PREFLIGHT_COMPOSER_WAIT_MS;
  if (raw == null || raw === "") return 30_000;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1_000 ? parsed : 30_000;
})();

/** 轮询直到出现可见且可编辑的 composer；超时返回 false，不抛错。 */
async function waitForComposer(page, timeoutMs = PREFLIGHT_COMPOSER_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  // 第一轮立即检查，避免页面其实已经就绪时白等一个 poll 周期。
  for (;;) {
    const found = await page
      .evaluate(() => {
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
        return [...document.querySelectorAll(
          'textarea, [contenteditable="true"], [role="textbox"]',
        )].some(visible);
      })
      .catch(() => false);
    if (found) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(500);
  }
}

function intEnv(name, fallback, min = 0) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`${name} 必须是不小于 ${min} 的整数`);
  }
  return parsed;
}

export function frontEndGuardConfig() {
  return {
    idleWaitMs: intEnv("ONEGL_FRONTEND_IDLE_WAIT_MS", 60_000, 1_000),
    pollMs: intEnv("ONEGL_FRONTEND_GUARD_POLL_MS", 750, 100),
    // A single "not busy" reading is not proof the turn finished: the progress row can
    // disappear between two stream chunks. Requiring consecutive idle readings costs a
    // couple of seconds and removes a whole class of premature sends.
    stableIdlePolls: intEnv("ONEGL_FRONTEND_STABLE_IDLE_POLLS", 3, 1),
  };
}

function isConversationUrl(raw) {
  try {
    const url = new URL(raw);
    return /\/chat\/[^/?#]+/.test(url.pathname);
  } catch {
    return false;
  }
}

async function frontEndSnapshot(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0"
      );
    };

    const controls = [...document.querySelectorAll('button, [role="button"]')].filter(visible);
    const stopVisible = controls.some((element) => {
      const text = `${element.getAttribute("aria-label") || ""} ${element.innerText || element.textContent || ""}`;
      return /停止生成|停止回答/.test(text);
    });

    const streamingVisible = [...document.querySelectorAll('[data-streaming="true"]')].some(visible);
    const progressVisible = [...document.querySelectorAll("div, span, p, li")]
      .filter((element) => element.childElementCount === 0)
      .filter(visible)
      .some((element) => {
        const text = (element.textContent || "").trim();
        return text.length > 0 && text.length <= 40 && /正在(搜索|思考|生成|查询|读取|分析|整理|执行|编写|获取|规划|联网)/.test(text);
      });

    const newConversationVisible = controls.some((element) => {
      const text = `${element.getAttribute("aria-label") || ""} ${element.innerText || element.textContent || ""}`.trim();
      return text === "新对话" || /(^|\s)新对话($|\s)/.test(text);
    });

    const composers = [...document.querySelectorAll(
      '[data-testid="chat_input_input"], textarea[placeholder*="发消息"], textarea[placeholder*="输入"], div[role="textbox"], textarea, [contenteditable="true"]',
    )].filter((element) => {
      if (!visible(element)) return false;
      if (element.closest('[role="dialog"], [aria-modal="true"]')) return false;
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        return !element.disabled && !element.readOnly;
      }
      return element.getAttribute("contenteditable") === "true" || element.getAttribute("role") === "textbox";
    });

    return {
      busy: stopVisible || streamingVisible || progressVisible,
      stopVisible,
      streamingVisible,
      progressVisible,
      newConversationVisible,
      composerCount: composers.length,
    };
  });
}

function throwForSessionState(state) {
  if (state?.state === "verification_required") {
    throw new DoubaoMvpError(
      ErrorCode.VERIFICATION_REQUIRED,
      "Doubao requires manual verification; conservative operation guard stopped the run.",
      { stage: "frontend-preflight", state },
    );
  }
  if (state?.state === "access_restricted") {
    throw new DoubaoMvpError(
      ErrorCode.ACCESS_RESTRICTED,
      "Doubao reports an access restriction; conservative operation guard stopped the run.",
      { stage: "frontend-preflight", state },
    );
  }
}

/**
 * Front-end preflight for one run.
 *
 * The goal is stability and platform friendliness, not automation evasion:
 * - never starts a new turn while the previous turn is still generating;
 * - never solves/chases verification automatically;
 * - prefers the ordinary chat entry when a conversation-specific page has lost its
 *   normal "新对话" control;
 * - records what it observed for later audit.
 */
export async function prepareFrontEndForRun(page, config, options = {}) {
  const guard = { ...frontEndGuardConfig(), ...options };
  const initialUrl = page.url();
  // 先确保页面已渲染出 composer，再做状态判定（见文件顶部注释）。
  // 超时只是让下面的 fail-closed 分支去报错，语义不变。
  await waitForComposer(page);
  let session = await inspectSession(page);
  throwForSessionState(session);

  let snapshot = await frontEndSnapshot(page);
  const wasBusy = snapshot.busy;
  const deadline = Date.now() + guard.idleWaitMs;
  let idleStreak = snapshot.busy ? 0 : 1;
  while (idleStreak < guard.stableIdlePolls && Date.now() < deadline) {
    await page.waitForTimeout(guard.pollMs);
    session = await inspectSession(page);
    throwForSessionState(session);
    snapshot = await frontEndSnapshot(page);
    idleStreak = snapshot.busy ? 0 : idleStreak + 1;
  }

  if (snapshot.busy || idleStreak < guard.stableIdlePolls) {
    throw new DoubaoMvpError(
      ErrorCode.SUBMISSION_FAILED,
      "The previous Doubao turn is still active; the next prompt was not submitted.",
      {
        stage: "frontend-preflight",
        reason: snapshot.busy ? "previous-turn-still-busy" : "frontend-not-stably-idle",
        idleStreak,
        requiredIdlePolls: guard.stableIdlePolls,
        initialUrl,
        snapshot,
      },
    );
  }

  let navigatedToChatRoot = false;
  if (isConversationUrl(page.url()) && !snapshot.newConversationVisible) {
    await page.goto(config.doubaoUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    navigatedToChatRoot = true;
    await page.waitForTimeout(1_000);
    await waitForComposer(page);
    session = await inspectSession(page);
    throwForSessionState(session);
    snapshot = await frontEndSnapshot(page);
  }

  // Fail closed on any state we could not positively identify. "unknown" here means the
  // page did not prove it is a usable, logged-in chat - continuing would send a prompt
  // into a page whose state we cannot describe, and the failure would surface much later
  // as an unexplainable timeout.
  if (session?.state !== "healthy") {
    throw new DoubaoMvpError(
      ErrorCode.PAGE_CHANGED,
      `Front-end preflight could not confirm a healthy chat page (state=${session?.state ?? "unknown"}).`,
      { stage: "frontend-preflight", initialUrl, currentUrl: page.url(), snapshot, session },
    );
  }

  if (snapshot.composerCount === 0) {
    throw new DoubaoMvpError(
      ErrorCode.PAGE_CHANGED,
      "The page looked logged in but no normal chat composer was visible.",
      { stage: "frontend-preflight", initialUrl, currentUrl: page.url(), snapshot },
    );
  }

  return {
    version: 1,
    initialUrl,
    finalUrl: page.url(),
    wasBusy,
    navigatedToChatRoot,
    newConversationVisible: snapshot.newConversationVisible,
    composerCount: snapshot.composerCount,
    workTaskFallbackBlocked: true,
  };
}

const EMPTY_LOCATOR = Object.freeze({
  async count() {
    return 0;
  },
  nth() {
    return this;
  },
  async isVisible() {
    return false;
  },
});

/**
 * Proxy a Playwright Page so legacy semantic fallback selectors for "新工作任务"
 * resolve to an empty locator. This prevents a missing "新对话" control from silently
 * switching the run into a different product mode. All other Page methods are bound
 * back to the real Playwright Page.
 */
export function createConservativeDoubaoPage(page) {
  return new Proxy(page, {
    get(target, property, receiver) {
      if (property === "getByRole") {
        return (role, options = {}) => {
          if (String(options?.name ?? "").trim() === "新工作任务") return EMPTY_LOCATOR;
          return target.getByRole(role, options);
        };
      }
      if (property === "getByText") {
        return (text, options = {}) => {
          if (String(text ?? "").trim() === "新工作任务") return EMPTY_LOCATOR;
          return target.getByText(text, options);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
