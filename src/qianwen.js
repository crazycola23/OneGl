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
    composer: profile.chat.composerSelectors[0],
    send: profile.chat.sendSelectors[0],
    userBubbleSelectors: profile.chat.userBubbleSelectors,
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
  const answerCards = [...document.querySelectorAll('[class*="message-card"]')]
    .filter((card) => visible(card) && !isUserBubble(card));
  const lastAnswer = answerCards.at(-1) ?? null;

  const composer = document.querySelector(cfg.composer);
  const send = document.querySelector(cfg.send);

  return {
    url: location.href,
    bodyText: textOf(document.body),
    composerPresent: Boolean(composer && visible(composer)),
    sendDisabled: send
      ? send.disabled === true
        || send.getAttribute("aria-disabled") === "true"
        || /cursor-not-allowed/.test(send.className)
      : null,
    generating: inProgress.length
      ? [...document.querySelectorAll("button, [role=button]")]
          .some((node) => visible(node) && inProgress.some((pattern) => pattern.test(textOf(node))))
      : false,
    answerLength: lastAnswer ? textOf(lastAnswer).length : 0,
    answer: lastAnswer ? textOf(lastAnswer) : null,
    links: lastAnswer
      ? [...lastAnswer.querySelectorAll("a[href]")].map((anchor) => ({
          url: anchor.href,
          title: textOf(anchor).slice(0, 200) || anchor.getAttribute("title") || null,
        }))
      : [],
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
    userBubbleSelectors: context.userBubbleSelectors,
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
export async function openQianwen(page, config, profile) {
  const context = driverContext(profile);
  await page
    .goto(profile.entryUrl, { waitUntil: "domcontentloaded", timeout: config.timeoutMs ?? 60_000 })
    .catch(() => undefined);
  await page.waitForTimeout(2_000);
  await page.keyboard.press("Escape").catch(() => undefined);
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
  // No force: force skips the hit-test and lands the click on whatever overlay is on top.
  await composer.click({ timeout: 10_000 });
  await composer.pressSequentially(prompt, { delay: 25 });

  const afterTyping = await scan(page, context);
  if (afterTyping.sendDisabled !== false) {
    const reason = classifyFailure(afterTyping, context);
    throw new DoubaoMvpError(
      reason ?? ErrorCode.SUBMISSION_FAILED,
      "千问发送键在键入后仍为禁用态，提问未送达。",
      { stage: "submit", sendDisabled: afterTyping.sendDisabled, promptSubmitted: false },
    );
  }
  await page.locator(context.send).first().click({ timeout: 10_000 });

  const deadline = Date.now() + (config.timeoutMs ?? 120_000);
  // Grace period first: immediately after the click the generation control has not appeared
  // yet, and checking it then reads as "already finished".
  await page.waitForTimeout(6_000);
  let latest = null;
  while (Date.now() < deadline) {
    latest = await scan(page, context);
    if (!latest.generating && latest.answerLength > 0) return latest;
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
  const scan = await submitAndWait(page, prompt, config, context);

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
    submissionMethod: "send_button",
    conversationReset: true,
    conversationResetConfirmed: true,
    modelVersion: scan.bodyText.match(/Qwen[\d.]+/)?.[0] ?? null,
    currentUrl: scan.url,
    loginState: "anonymous",
  };
}
