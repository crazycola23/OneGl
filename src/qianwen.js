import { DoubaoMvpError, ErrorCode } from "./errors.js";
import { canonicalizeUrl, domainFromUrl, isExternalSourceUrl } from "./url.js";

/**
 * 千问 Web 采集驱动。
 *
 * 只使用 tools/provider-phase0.js 对 www.qianwen.com 匿名实测到的结构：
 *   composer   [data-slate-editor="true"]（Slate；同时带 data-placeholder="向千问提问"，
 *              选属性不选文案，因为文案是产品会改的那个）
 *   send       [data-session-switch-target="send-query"]（始终存在，空输入时 disabled）
 *   进行中     按钮文案「停止回答」
 *   会话 URL   /chat/<32 位 hex>
 *   用户气泡   class 含 message-card-wrap + question，data-mt="text/plain"
 *   自陈计数   「已完成分析，共参考 N 篇资料」/「搜索 N 个关键词，参考 M 篇资料」，
 *              容器 data-card_name="bar_workflow"
 *
 * The profile arrives as an argument rather than an import: the adapter owns the profile, and
 * a driver that reached back into providers/ would close the import cycle.
 */

function toRegExpList(entries = []) {
  return entries
    .map((entry) => (entry instanceof RegExp ? entry : typeof entry === "string" && entry ? new RegExp(entry) : null))
    .filter(Boolean);
}

function driverContext(profile) {
  const countPattern = toRegExpList([profile.citation.countPattern])[0] ?? null;
  return {
    // Joined so a build that drops one control still matches the others: the send button was
    // measured under two different selectors on Chromium and on Camoufox.
    composer: profile.chat.composerSelectors.join(","),
    send: profile.chat.sendSelectors.join(","),
    answerSelectors: profile.chat.answerSelectors ?? [],
    userBubbleSelectors: profile.chat.userBubbleSelectors,
    citationBlockSelectors: profile.citation.blockSelectors ?? [],
    busyWhenSendMissing: profile.chat.busyWhenSendMissing === true,
    inProgressPatterns: toRegExpList(profile.chat.inProgressPatterns),
    countPattern,
    quota: toRegExpList(profile.quota?.exhaustedPatterns),
    captcha: toRegExpList(profile.login.captchaPatterns),
    restricted: toRegExpList(profile.login.restrictedPatterns),
    interstitials: profile.interstitials?.dismissSelectors ?? ['button:has-text("关闭")', '[aria-label="关闭"]'],
  };
}

/**
 * Runs inside page.evaluate, so it must not close over anything from this module: selectors
 * arrive as strings and regular expressions are rebuilt from their source, which is the same
 * hand-off shape src/doubao.js uses for its page scans.
 */
function scanQianwenPage(cfg) {
  const visible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const textOf = (element) => (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
  const compile = (source) => {
    if (!source) return null;
    try {
      return new RegExp(source);
    } catch {
      return null;
    }
  };
  const inProgress = (cfg.inProgressSources ?? []).map(compile).filter(Boolean);
  const countPattern = compile(cfg.countPatternSource);

  // The question card has a readable class (`message-card-wrap question`) while the answer
  // card's name is hashed (`message-card-j_n6rq`), so `message-card` is the only substring
  // covering both - the assistant turn is identified by excluding the user bubble. Excluding
  // is deliberate: reading the wrong card puts our own prompt into the answer, and brand
  // detection then reports the brand we asked about as a brand that was mentioned.
  const isUserBubble = (card) =>
    /(^|\s)question(\s|$)/.test(card.className) ||
    (cfg.userBubbleSelectors ?? []).some((selector) => {
      try {
        return card.matches(selector);
      } catch {
        return false;
      }
    });
  const answerSelector = (cfg.answerSelectors ?? []).join(",") || '[class*="message-card"]';
  const candidates = [...document.querySelectorAll(answerSelector)]
    .filter((card) => visible(card) && !isUserBubble(card));
  // One answer is rendered as several *sibling* cards on this surface, so taking the last match
  // reads only the final fragment - measured: a "successful" run stored a 26-character answer
  // (and another 15 characters) while the page held the whole thing. Keep the outermost cards
  // (a card nested inside another is already covered) and read them in document order.
  const answerCards = candidates.filter(
    (card) => !candidates.some((other) => other !== card && other.contains(card)),
  );
  const answerText = answerCards.map((card) => textOf(card)).filter(Boolean).join("\n").trim();

  const composer = document.querySelector(cfg.composer);
  const send = document.querySelector(cfg.send);
  const sendVisible = Boolean(send && visible(send));

  // "message-card" matches several nested and sibling cards within one turn, so taking the
  // last one is not "the assistant answer": measured that way the answer text was right while
  // every citation anchor was missed, because the anchors live in the
  // [data-card_name="bar_workflow"] card. Links therefore come from every block the profile
  // names as a citation container, with the answer card added as a source.
  const citationBlocks = (cfg.citationBlockSelectors ?? []).flatMap((selector) => {
    try {
      return [...document.querySelectorAll(selector)];
    } catch {
      return [];
    }
  });
  const anchors = new Map();
  for (const source of [...answerCards, ...citationBlocks]) {
    for (const anchor of source.querySelectorAll("a[href]")) {
      if (anchors.has(anchor.href)) continue;
      anchors.set(anchor.href, textOf(anchor).slice(0, 200) || anchor.getAttribute("title") || null);
    }
  }

  // "停止回答" is the platform's own generation control, matched as button text rather than as
  // a class, because classes are what changes between builds. Camoufox was measured to show no
  // such control at all, so a profile can instead declare the busy *absence* of the send
  // control - read only while an answer card exists, so the empty home page is never "busy".
  const generatingByPattern = inProgress.length
    ? [...document.querySelectorAll("button, [role=button]")]
        .some((node) => visible(node) && inProgress.some((pattern) => pattern.test(textOf(node))))
    : false;
  const generatingByBusyControl = cfg.busyWhenSendMissing === true
    && Boolean(composer && visible(composer))
    && !sendVisible
    && answerCards.length > 0;

  return {
    url: location.href,
    bodyText: textOf(document.body),
    composerPresent: Boolean(composer && visible(composer)),
    sendDisabled: send
      ? send.disabled === true
        || send.getAttribute("aria-disabled") === "true"
        || /cursor-not-allowed/.test(send.className)
      : null,
    // "停止回答" is the platform's own generation control, matched as button text rather than
    // as a class, because classes are what changes between builds. Camoufox was measured to show
    // no such control at all, so a profile can instead declare the busy *absence* of the send
    // control - which is only read while an answer card exists, never on the empty home page.
    generating: generatingByPattern || generatingByBusyControl,
    answerLength: answerText.length,
    answer: answerText || null,
    links: [...anchors].map(([url, title]) => ({ url, title })),
    countTexts: countPattern
      ? [...document.querySelectorAll("[data-card_name]")]
          .map((node) => textOf(node))
          .filter((value) => value && countPattern.test(value))
      : [],
  };
}

function scanConfig(context) {
  return {
    composer: context.composer,
    send: context.send,
    answerSelectors: context.answerSelectors ?? [],
    userBubbleSelectors: context.userBubbleSelectors,
    citationBlockSelectors: context.citationBlockSelectors,
    busyWhenSendMissing: context.busyWhenSendMissing === true,
    inProgressSources: context.inProgressPatterns.map((pattern) => pattern.source),
    countPatternSource: context.countPattern?.source ?? null,
  };
}

function scan(page, context) {
  return page.evaluate(scanQianwenPage, scanConfig(context));
}

/**
 * Classify a non-productive page. The order is the point: a quota cap and a risk-control
 * block look alike until you check, and mistaking a block for a cap puts a campaign to sleep
 * instead of escalating it.
 */
function classifyFailure(scan, context) {
  const text = scan?.bodyText ?? "";
  if (context.quota.some((pattern) => pattern.test(text))) return ErrorCode.RATE_LIMITED;
  if (context.captcha.some((pattern) => pattern.test(text))) return ErrorCode.VERIFICATION_REQUIRED;
  if (context.restricted.some((pattern) => pattern.test(text))) return ErrorCode.ACCESS_RESTRICTED;
  return null;
}

/**
 * Open the entry page and clear interstitials.
 *
 * The marketing overlay is not decoration: it holds the pointer and swallows Enter, and every
 * "submit did nothing" observed during Phase 0 traced back to it.
 */
/**
 * Make the composer genuinely clickable, or say so.
 *
 * 千问's home page can mount a guide-carousel dialog (`div[role="dialog"]` around
 * `img[data-testid="home-guide-carousel-image"]`) above the composer. It has no 关闭 button and
 * it intercepts pointer events, so one Escape at a fixed delay is not enough - the dialog can
 * mount *after* the attempt, and the failure then surfaces downstream as a 10-second
 * `locator.click` timeout with nothing captured. A trial click checks actionability without
 * clicking, so dismissal is retried until the composer is really reachable.
 */
async function waitForClickableComposer(page, context, { timeoutMs = 30_000 } = {}) {
  const composer = page.locator(context.composer).first();
  const deadline = Date.now() + timeoutMs;
  let dismissalAttempts = 0;
  for (;;) {
    try {
      await composer.click({ trial: true, timeout: 2_000 });
      await composer.click({ timeout: 5_000 });
      return { clickable: true, dismissalAttempts, mode: "click" };
    } catch {
      // not clickable yet
    }
    // Measured on the shipped Camoufox build: the home page keeps something intercepting pointer
    // events over the composer, so a click never lands, while focusing the editor through the DOM
    // and typing with the keyboard does reach it and the answer comes back. Accept focus as
    // usable - submitAndWait still verifies the text arrived, so this cannot record an empty
    // answer as a real one (the send control only enables once the editor holds the prompt).
    const focused = await page
      .evaluate((selector) => {
        const editor = document.querySelector(selector);
        if (!editor) return false;
        editor.focus();
        return document.activeElement === editor;
      }, context.composer)
      .catch(() => false);
    if (focused) return { clickable: true, dismissalAttempts, mode: "focus" };
    if (Date.now() > deadline) return { clickable: false, dismissalAttempts };
    dismissalAttempts += 1;
    await page.keyboard.press("Escape").catch(() => undefined);
    for (const selector of context.interstitials) {
      await page.locator(selector).first().click({ timeout: 1_500 }).catch(() => undefined);
    }
    await page.waitForTimeout(700);
  }
}

export async function openQianwen(page, config, profile) {
  const context = driverContext(profile);
  await page
    .goto(profile.entryUrl, { waitUntil: "domcontentloaded", timeout: config.timeoutMs ?? 60_000 })
    .catch(() => undefined);
  await page.waitForTimeout(2_000);
  for (const selector of context.interstitials) {
    await page.locator(selector).first().click({ timeout: 2_000 }).catch(() => undefined);
  }
  const composer = page.locator(context.composer).first();
  await composer.waitFor({ state: "visible", timeout: 20_000 }).catch(() => undefined);
  if (!(await composer.isVisible().catch(() => false))) {
    const current = await scan(page, context).catch(() => null);
    throw new DoubaoMvpError(
      classifyFailure(current, context) ?? ErrorCode.LOGIN_REQUIRED,
      "千问对话输入框未出现，匿名采集无法开始。",
      { stage: "open", url: current?.url ?? page.url() },
    );
  }
  // Short budget at open: this is best-effort clean-up, and the authoritative check happens at
  // submit time. Deliberately not thrown here - openPage runs before the run record exists, so
  // a throw would lose the failure entirely (no runs row, no error code, nothing for reports or
  // alerting to see). Doubao keeps its session checks inside the execution for this reason.
  const clickable = await waitForClickableComposer(page, context, { timeoutMs: 8_000 });
  if (!clickable.clickable) {
    console.warn(
      `[qianwen] 打开阶段未能让输入框可点击（清浮层 ${clickable.dismissalAttempts} 次），留到提交时再判`,
    );
  }
  return page;
}

/**
 * Submit and wait for generation to end.
 *
 * Completion is the absence of the "停止回答" control, not stable text: one measured run held
 * a few hundred characters of body text for the entire window while still generating, because
 * the deep-search phase produces no DOM growth. A text-stability wait would have finished on
 * an empty answer and recorded it as a real one.
 */
async function submitAndWait(page, prompt, config, context) {
  const composer = page.locator(context.composer).first();
  // Authoritative here, inside the run: if an overlay still owns the page, this throws after
  // the run record exists so the failure carries an error code instead of vanishing.
  const clickable = await waitForClickableComposer(page, context);
  if (!clickable.clickable) {
    throw new DoubaoMvpError(
      ErrorCode.PAGE_CHANGED,
      "千问首页浮层持续遮挡输入框且清不掉；本轮不提问，避免把一次失败记成空答案。",
      { stage: "submit", dismissalAttempts: clickable.dismissalAttempts, url: page.url(), promptSubmitted: false },
    );
  }
  // openQianwen already focused the composer, and Slate re-renders the editable node on focus.
  // Clicking a second time waits on a node that has since been replaced, which is how a run
  // died on a 10s click timeout *after* a successful open. Only click when it is not focused.
  const focused = await page
    .evaluate(() => document.activeElement?.getAttribute("data-slate-editor") === "true")
    .catch(() => false);
  if (!focused) {
    if (clickable.mode === "focus") {
      await page.evaluate((selector) => document.querySelector(selector)?.focus(), context.composer);
    } else {
      // No force: force skips the hit-test and lands the click on whatever overlay is on top.
      await composer.click({ timeout: 6_000 });
    }
  }
  if (clickable.mode === "focus") {
    // Typed at the keyboard rather than through the locator: that is the path measured to work
    // when a pointer click cannot reach the editor at all.
    await page.keyboard.type(prompt, { delay: 25 });
  } else {
    await composer.pressSequentially(prompt, { delay: 25 });
  }

  const afterTyping = await scan(page, context);
  if (afterTyping.sendDisabled !== false) {
    const reason = classifyFailure(afterTyping, context);
    throw new DoubaoMvpError(
      reason ?? ErrorCode.SUBMISSION_FAILED,
      "千问发送键在键入后仍为禁用态，提问未送达。",
      { stage: "submit", sendDisabled: afterTyping.sendDisabled, promptSubmitted: false },
    );
  }
  // Order matters, and it is the measured order: on the shipped Camoufox build a pointer click
  // never lands (something intercepts it over the send control) while dispatching the button's
  // own click event and pressing Enter both submit. A *force* click is deliberately last and
  // never before those two: it reports success without hitting the button, which made a run look
  // submitted and then burn its whole timeout waiting for an answer nobody asked for.
  const send = page.locator(context.send).first();
  const sentBy = await send
    .dispatchEvent("click", undefined, { timeout: 4_000 })
    .then(() => "dispatch_click")
    .catch(async () => {
      try {
        await page.keyboard.press("Enter");
        return "enter";
      } catch {
        try {
          await send.click({ timeout: 4_000 });
          return "click";
        } catch {
          await send.click({ force: true, timeout: 4_000 });
          return "force_click";
        }
      }
    });

  const deadline = Date.now() + (config.timeoutMs ?? 120_000);
  // Grace period first: immediately after the click the generation control has not appeared
  // yet, and checking it then reads as "already finished".
  await page.waitForTimeout(6_000);
  let latest = null;
  let stablePolls = 0;
  while (Date.now() < deadline) {
    const previous = latest;
    latest = await scan(page, context);
    // Completion needs the answer to have stopped growing, whatever else the page says. Measured
    // on the shipped Camoufox build, none of the obvious markers work: the "内容由AI生成" footer is
    // on the page from the start, the per-message action buttons never render without a hover, and
    // the send control comes back while the answer is still being written. What the platform does
    // do is pause: one answer sat at 104 characters for 56 seconds and then continued to 816, so
    // the quiet window has to be comfortably longer than that pause - a 60s window cut real answers
    // in half (and a 12s one captured 15 characters).
    stablePolls = previous && previous.answerLength > 0 && previous.answerLength === latest.answerLength
      ? stablePolls + 1
      : 0;
    if (latest.answerLength > 0 && stablePolls >= 30 && !latest.generating) {
      return { scan: latest, sentBy };
    }
    if (latest.answerLength > 0 && stablePolls >= 45 && latest.sendDisabled === false) {
      return { scan: latest, sentBy };
    }
    const reason = classifyFailure(latest, context);
    if (reason) {
      throw new DoubaoMvpError(reason, "千问在生成过程中报告了受限状态。", {
        stage: "generating",
        url: latest.url,
        promptSubmitted: true,
        partialAnswer: latest.answerLength > 200 ? latest.answer : null,
      });
    }
    await page.waitForTimeout(config.pollMs ?? 3_000);
  }
  throw new DoubaoMvpError(
    ErrorCode.TIMEOUT,
    `千问未在 ${config.timeoutMs ?? 120_000}ms 内结束生成。`,
    {
      stage: "generating",
      promptSubmitted: true,
      generating: latest?.generating ?? null,
      partialAnswer: latest && latest.answerLength > 200 ? latest.answer : null,
    },
  );
}

/**
 * Reconcile citations against what 千问 states on screen.
 *
 * 千问 self-reports a source count, so this surface uses the same counting tier as Doubao.
 * The reported number is of *materials*, while several links can collapse into one canonical
 * URL after de-duplication, so only "captured fewer than reported" is a mismatch - the other
 * direction is normal and must not be flagged.
 */
function reconcileCitations(scan, context) {
  const seen = new Set();
  const citations = [];
  const discarded = { internalHost: 0, unparseable: 0, duplicate: 0 };
  for (const row of scan.links ?? []) {
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
    citations.push({
      title: row.title || null,
      url: row.url,
      canonicalUrl,
      domain: domainFromUrl(canonicalUrl),
      sourcePosition: citations.length + 1,
      citationMarker: null,
      answerText: null,
      sourceType: "visible",
      capturedFrom: "DOM",
      visibleToUser: true,
      relationStatus: "unresolved",
    });
  }

  const diagnostics = [];
  let expectedCount = null;
  for (const value of scan.countTexts ?? []) {
    const match = context.countPattern.exec(value);
    if (match) {
      // Group 2 is the 参考 M 篇资料 number; 千问 phrasing mirrors Doubao's.
      expectedCount = Number(match[2] ?? match[1]) || null;
      diagnostics.push("qianwen-self-reported-count");
      break;
    }
  }
  if (expectedCount === null) {
    diagnostics.push("reference-count-not-observed");
  } else if (citations.length < expectedCount) {
    diagnostics.push(`reference-count-mismatch:${citations.length}/${expectedCount}`);
  }

  return {
    citations,
    expectedCount,
    diagnostics: [...new Set(diagnostics)],
    state: expectedCount !== null && citations.length < expectedCount ? "count_mismatch" : "ok",
    discarded,
  };
}

export async function executeQianwenPrompt(page, prompt, config, profile) {
  const context = driverContext(profile);
  const before = page.url();
  const { scan, sentBy } = await submitAndWait(page, prompt, config, context);

  // On an anonymous surface the platform's own conversation id is the freshness proof: if the
  // URL never became /chat/<id>, this sample could not be re-opened for audit later, so the
  // run fails closed instead of storing an unanswerable record.
  const conversationId = scan.url.match(/\/chat\/([a-z0-9-]{16,})/)?.[1] ?? null;
  if (!conversationId) {
    throw new DoubaoMvpError(
      ErrorCode.CONVERSATION_RESET_FAILED,
      "千问提交后没有进入可识别的会话地址，样本无法回查。",
      { stage: "conversation", before, after: scan.url, promptSubmitted: true },
    );
  }

  const citationResult = reconcileCitations(scan, context);
  return {
    answer: scan.answer,
    citations: citationResult.citations,
    citationState: citationResult.state,
    expectedCitationCount: citationResult.expectedCount,
    citationDiagnostics: citationResult.diagnostics,
    citationCounts: {
      expected: citationResult.expectedCount,
      domLinks: (scan.links ?? []).length,
      captured: citationResult.citations.length,
      discarded: citationResult.discarded,
    },
    submissionMethod: sentBy,
    conversationReset: true,
    conversationResetConfirmed: true,
    modelVersion: scan.bodyText.match(/Qwen[\d.]+/)?.[0] ?? null,
    currentUrl: scan.url,
    loginState: "anonymous",
  };
}
