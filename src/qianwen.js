import { intEnvValue } from "./accounts/safety.js";
import { DoubaoMvpError, ErrorCode } from "./errors.js";
import { parseAnswerSources } from "./qianwen-answer-sources.js";
import { decodeProxyImageSources, sourceLabel } from "./qianwen-source-icons.js";
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
    loginSurfaceSelectors: profile.login.loginSurfaceSelectors ?? [],
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

  // The wall's own copy lives inside a cross-origin iframe (passport.qianwen.com), so no amount
  // of body-text scanning can read it - measured on a walled page whose screenshot shows
  // 「登录解锁完整功能」 while `document.body.innerText` contains none of it. The iframe is
  // injected when the wall appears and is absent on healthy runs, so its presence is the signal.
  const loginSurfacePresent = (cfg.loginSurfaceSelectors ?? []).some((selector) => {
    try {
      return [...document.querySelectorAll(selector)].some((node) => visible(node));
    } catch {
      return false;
    }
  });

  return {
    url: location.href,
    bodyText: textOf(document.body),
    loginSurfacePresent,
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
    // 引用来源的 favicon 列表。
    //
    // 千问的引用**不渲染成文本或链接**：页面上只有一排 `search-icon-item > img`，每个 img 的
    // src 是图片代理 URL，其 `key=` 参数是 base64 编码的**原始来源 URL**。正文里也没有 URL，
    // <a> 里也没有（实测全页锚点数为 0）—— 这是唯一承载来源地址的地方。
    // 解码在 qianwen-source-icons.js 里做（可单测）。
    referenceIconSources: [...document.querySelectorAll('[class*="reference-wrap"] img[src], [class*="search-icon-item"] img[src]')]
      .map((img) => img.getAttribute("src"))
      .filter(Boolean),
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
    // Every field scanQianwenPage reads has to be listed here: this function is the only path
    // across the page.evaluate boundary, and a field missing from it arrives as undefined -
    // which is how the login-surface check silently did nothing while looking correct on both
    // sides of the boundary.
    loginSurfaceSelectors: context.loginSurfaceSelectors ?? [],
  };
}

function scanPage(page, context) {
  return page.evaluate(scanQianwenPage, scanConfig(context));
}

/**
 * Classify a non-productive page. The order is the point: a quota cap and a risk-control
 * block look alike until you check, and mistaking a block for a cap puts a campaign to sleep
 * instead of escalating it.
 */
function classifyFailure(scan, context) {
  // Checked before the text patterns: this is the one signal that does not depend on reading
  // the page's copy, which the wall hides inside a cross-origin iframe.
  if (scan?.loginSurfacePresent) return ErrorCode.LOGIN_REQUIRED;
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
    const current = await scanPage(page, context).catch(() => null);
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
 * How long a finished answer has to hold before capture is allowed to stop.
 *
 * Size this against measurements, never against a poll count. The gate used to read "30 polls",
 * which looks like 45s at DOUBAO_POLL_MS=1500 but was really ~92s per run, because every poll also
 * pays a page.evaluate round trip. The measured shape of the current pipeline over 51 successful
 * Qianwen runs is:
 *
 *   20-60s   11 runs,  0 truncated   - the platform actually finished
 *   80-100s  38 runs, 20 truncated   - the gate closing, and half the time closing too early
 *   140s+     2 runs,  0 truncated
 *
 * So ~92s is demonstrably too short. 150s is a deliberately conservative lift on top of that, not a
 * calibrated value: runs that cluster at 80-100s are the capture stopping, not the answer ending.
 * Size it against measurements, never against a poll count - recalibrate it against a real batch
 * before treating the number as correct.
 *
 * 【2026-09-24 实测回退】曾试图把它提到 180s「换取更强免疫力」，代价立刻显现：一条采集在
 * 1014 秒后被 DOUBAO_TIMEOUT 判死。窗口越长，「答案长度连续不动」这个条件越难满足，而平台的
 * 生成过程中本来就可能有超过窗口的持续微变；于是窗口不是「更稳」，而是变成一条必然拖到超时
 * 的路径。窗口的代价不是线性的 —— 超过某个点，它就从「等答案写完」翻转成「等不到任何时刻
 * 可以收尾」。所以这个值要贴着实测观察走，不要凭「更保守 = 更安全」去外推。
 */
const ANSWER_QUIET_MS = 150_000;

/**
 * The window below which the answer is known to be cut - the whole 80-100s bucket is the gate
 * closing, so a window under that cannot be justified by anything measured. A budget too small to
 * fund this is a configuration error rather than a reason to capture fragments.
 */
const ANSWER_QUIET_FLOOR_MS = 100_000;

/** Generation time the timeout still has to cover on top of one full quiet window. */
const ANSWER_TIMEOUT_HEADROOM_MS = 60_000;

/**
 * 答案末尾出现收尾特征后，还需要它静止多久才算结束。
 *
 * 存在的理由是实测观察到的一个固定形态（2026-09-24，#66 的 10 条成功记录里 6 条如此）：
 * 千问给出完整答案后会**以反问句收尾**引导继续对话，例如
 *   「…来选择最适合你的一家。」
 *   「…你更倾向于去正规诊所看毛病，还是去推拿店放松一下？」
 *   「…你想先了解哪一家的具体价位或者预约方式吗？」
 *
 * 那是「这一轮写完了」的强信号，而 150s 的通用静默窗是为「平台中途长时间停顿」准备的
 * （实测一条答案在 104 字上停了 56 秒才继续，见 ANSWER_QUIET_MS 的注释）。两者要分开：
 * 用 150s 去确认一个已经收尾的答案，等于每条白等 100 秒。
 *
 * 不能压到更低：平台的停顿可以到 56 秒，窗口必须显著大于它，否则收尾特征之后的续写会被截掉
 * —— 那正是 4.3 节里「窗口太短变截断」的老路。
 */
const ANSWER_QUIET_SETTLED_MS_DEFAULT = 75_000;

/** 下限 30s：低于「平台中途最长停顿」的窗口会把收尾之后的续写截掉，那正是本文件反复防的事。 */
function answerQuietSettledMs() {
  return intEnvValue("ONEGL_ANSWER_QUIET_SETTLED_MS", ANSWER_QUIET_SETTLED_MS_DEFAULT, 30_000);
}

/**
 * 提交后「一个字符都没出现」的容忍窗 —— 越过就判定这次请求被平台静默丢弃，提前退出。
 *
 * 判决依据来自 2026-09-26 批次 68 的现场（6 条拖满 900s 预算的任务，artifact 逐条比对）：
 *
 *   generating: true          页面停在 `answer-common-card answer-receiving-card` + spinner
 *   answer card 数 = 0        答案卡片从未出现（question card = 1，提问确实送出去了）
 *   login / captcha / accessRestricted 全 false，页面上没有任何拒绝文案
 *
 * 也就是**前端已建立流式接收状态，服务端一个 token 都不推**。它和历史记录的「慢响应」
 * （40–99 分钟才写完，但 answerSeen 一路上涨）是两件不同的事：这批到最后一秒都是 0 字。
 * 加预算救不了零输出的会话 —— 按 6 条算只是白占约 78 分钟槽位，那些时间本可以给
 * `b68_i32` 那种「真的慢但能出结果」的任务（938s 仍然吐了 1556 字）。
 *
 * 120s 是**推理值，不是实测值**，标注在此以便校准：同批次最快的一条 129s 就完成了 744 字，
 * 若首字延迟接近 120s，剩下 9 秒要写出 744 字（≈83 字/秒），而全部成功任务的整段平均速率
 * 只落在 1.7–5.8 字/秒之间 —— 差一个数量级。所以正常任务的首字延迟必然远小于 120s。
 * 每次成功采集都会打一条 `[qianwen] first-token` 日志记录真实首字延迟，用它校准这个数。
 *
 * 误杀的代价是可控的：这类失败的提问已提交、样本为空，落在 `.ops/recover-batch.mjs` 的
 * empty-answer 档，带 `--allow-resubmit` 就能重跑；而白等的代价是固定的 900 秒槽位。
 * 所以判据只认「**从未**出现过答案」（firstTokenSeen），一旦出过一个字就永久关闭 ——
 * 页面重渲染让某次采样读到 0 不能当成「没答」，那会把慢任务误杀。
 *
 * 下限 30s：低于它的窗口会把「平台正在排队/预热」误判成吞请求。
 */
const ANSWER_FIRST_TOKEN_MS_DEFAULT = 120_000;

function answerFirstTokenMs() {
  return intEnvValue("ONEGL_ANSWER_FIRST_TOKEN_MS", ANSWER_FIRST_TOKEN_MS_DEFAULT, 30_000);
}

/**
 * 「提交后一直零字」是否已经越过容忍窗。
 *
 * 导出是为了能被单独测试 —— 这个判定直接决定要不要主动放弃一条**已经提交**的样本，
 * 和 `looksSettled` 一样，判错的代价不可逆（重跑就是重复提问）。
 */
export function isSilentlyDropped({ answerLength, firstTokenSeen, waitedMs, windowMs }) {
  if (firstTokenSeen) return false;
  if (answerLength > 0) return false;
  return waitedMs >= windowMs;
}

/**
 * 答案末尾是否呈现收尾特征。
 *
 * 只看**末尾几个字符**：问号在答案中间大量出现（列表、小标题），拿全文判断会把「还在写」
 * 误判成「已写完」。同时要求答案已有一定长度 —— 一个刚开头就带问号的片段不该被当成完整答案。
 */
const ANSWER_SETTLED_MIN_CHARS = 120;
const ANSWER_TAIL_INSPECT_CHARS = 24;
const ANSWER_SETTLED_TAIL_PATTERN = /(？|\?|。|！|!|…|~|～)\s*$/;

/**
 * 答案末尾是否呈现收尾特征。
 *
 * 导出是为了能被单独测试 —— 这个判定直接决定「提前结束采集」还是「继续等」，
 * 判错的代价是截断一条数据，而截断不可逆（提问已提交，重试会重复提问）。
 */
export function looksSettled(answer) {
  const text = String(answer ?? "").replace(/\s+$/, "");
  if (text.length < ANSWER_SETTLED_MIN_CHARS) return false;
  return ANSWER_SETTLED_TAIL_PATTERN.test(text.slice(-ANSWER_TAIL_INSPECT_CHARS));
}

/**
 * Submit and wait for generation to end.
 *
 * Completion is a twin gate: the answer has to stop growing for a full quiet window *and* the
 * platform has to look idle. Neither signal is sufficient alone. Text stability by itself once
 * finished on an empty answer and recorded it as a real one; the idle signals cannot be trusted
 * either, because the send control comes back while the answer is still being written. So the
 * quiet window does the work and the idle signal only breaks the tie.
 *
 * An answer that never renders keeps answerLength at 0, which fails both gates and ends in
 * TIMEOUT instead of a success - that is the intended fail-closed direction, and it is what the
 * 2026-09-22 samples got wrong.
 */
async function submitAndWait(page, prompt, config, context) {
  // Long windows need long budgets. Rather than refuse a budget that cannot fund the target window,
  // take what the budget can pay for down to the floor: a deployment on a tighter timeout then
  // captures with the widest window it can afford instead of failing every run outright.
  const budgetMs = config.timeoutMs ?? 120_000;
  const affordableMs = budgetMs - ANSWER_TIMEOUT_HEADROOM_MS;
  if (affordableMs < ANSWER_QUIET_FLOOR_MS) {
    // UNKNOWN_ERROR on purpose: this is a configuration contract, not a provider observation. It is
    // neither retryable nor account-blocking, so a misconfigured budget can never put a healthy
    // account into cooldown or be read downstream as platform behaviour.
    throw new DoubaoMvpError(
      ErrorCode.UNKNOWN_ERROR,
      `千问超时预算 ${budgetMs}ms 连 ${ANSWER_QUIET_FLOOR_MS}ms 的静默窗口加 ${ANSWER_TIMEOUT_HEADROOM_MS}ms 生成余量都容不下，`
        + "该配置下长答案必然被截断。",
      {
        stage: "submit",
        timeoutMs: budgetMs,
        quietTargetMs: ANSWER_QUIET_MS,
        quietFloorMs: ANSWER_QUIET_FLOOR_MS,
        headroomMs: ANSWER_TIMEOUT_HEADROOM_MS,
        promptSubmitted: false,
      },
    );
  }
  const quietWindowMs = Math.min(ANSWER_QUIET_MS, affordableMs);
  // 零字容忍窗同样受预算约束：预算撑不满它时按付得起的来，否则「提前」退出反而会晚于预算到期。
  const firstTokenWindowMs = Math.min(answerFirstTokenMs(), affordableMs);
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

  const afterTyping = await scanPage(page, context);
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

  // 计时起点是**提交动作之后**，不含开页面、清浮层、敲字这些准备时间 —— 实测那部分只占约 3 秒
  // （批次 68 六条超时任务的 finished_at - last_attempt_started_at 都是 903~904s，预算 900s）。
  const submittedAt = Date.now();
  const deadline = submittedAt + budgetMs;
  // Grace period first: immediately after the click the generation control has not appeared
  // yet, and checking it then reads as "already finished".
  await page.waitForTimeout(6_000);
  let latest = null;
  let sampledAt = 0;
  // 首个字符出现的时刻（相对 submittedAt）。null = 到现在一个字符都没出现过。
  let firstTokenMs = null;
  // When the answer last changed length. A run of equal-length samples inherits the first one's
  // timestamp, so the quiet window is measured from the last real growth, not from the last poll.
  let quietSince = null;
  while (Date.now() < deadline) {
    const previous = latest;
    const previousAt = sampledAt;
    latest = await scanPage(page, context);
    const now = Date.now();
    sampledAt = now;
    // Completion needs the answer to have stopped growing, whatever else the page says. Measured
    // on the shipped Camoufox build, none of the obvious markers work: the "内容由AI生成" footer is
    // on the page from the start, the per-message action buttons never render without a hover, and
    // the send control comes back while the answer is still being written. What the platform does
    // do is pause - that pause is what the quiet window is sized against, so the window decides and
    // the idle signal only breaks the tie.
    const unchanged = Boolean(previous)
      && previousAt > 0
      && previous.answerLength > 0
      && previous.answerLength === latest.answerLength;
    quietSince = unchanged ? (quietSince ?? previousAt) : null;
    const quietMs = quietSince == null ? 0 : now - quietSince;
    // 首字延迟的观测点。一旦出现过答案，`isSilentlyDropped` 就永久关闭 —— 后面的采样再读到 0
    // （页面重渲染、卡片重挂）也不是「没答」。
    if (latest.answerLength > 0 && firstTokenMs === null) firstTokenMs = now - submittedAt;
    if (
      isSilentlyDropped({
        answerLength: latest.answerLength,
        firstTokenSeen: firstTokenMs !== null,
        waitedMs: now - submittedAt,
        windowMs: firstTokenWindowMs,
      })
    ) {
      // 与超时分开报：两者都是「没拿到答案」，但一个是平台吞了请求（等多久都没用），
      // 一个是预算不够（加预算有用）。结论混在一起就会重复 2026-09-26 那次误判 ——
      // 把「零输出」读成「匿名额度用尽」，进而去改配额而不是改判据。
      throw new DoubaoMvpError(
        ErrorCode.ANSWER_NOT_FOUND,
        `千问提交后 ${Math.round((now - submittedAt) / 1000)}s 内没有产出任何字符，`
          + `判定这次请求被平台静默丢弃，提前退出（不再空耗 ${Math.round(budgetMs / 1000)}s 预算）。`,
        {
          stage: "generating",
          url: latest.url,
          promptSubmitted: true,
          answerSeen: 0,
          generating: latest.generating ?? null,
          waitedMs: now - submittedAt,
          firstTokenWindowMs,
          budgetMs,
        },
      );
    }
    // 已收尾的答案用更短的确认窗：收尾特征（反问/句末标点）说明这一轮写完了，而通用窗口的
    // 长度是为「平台中途长停顿」准备的。两者混用会让每条白等约 100 秒。
    const effectiveQuietMs = looksSettled(latest.answer) ? answerQuietSettledMs() : quietWindowMs;
    if (latest.answerLength > 0 && quietMs >= effectiveQuietMs && !latest.generating) {
      // 结构化的首字延迟日志：`ANSWER_FIRST_TOKEN_MS_DEFAULT` 是推理值，靠这条日志校准。
      console.log(
        `[qianwen] first-token ${Math.round((firstTokenMs ?? 0) / 1000)}s`
          + ` | answer ${latest.answerLength} chars`
          + ` | total ${Math.round((now - submittedAt) / 1000)}s / budget ${Math.round(budgetMs / 1000)}s`,
      );
      return { scan: latest, sentBy };
    }
    // The fallback needs a longer window precisely because its signal is weaker: it only asks that
    // the send control be usable, so it must wait half again as long before trusting that.
    // 它的门槛跟着有效窗口走，否则收尾后仍要等到基础窗口的 1.5 倍才放行，等于把上面的节省吃掉。
    if (latest.answerLength > 0 && quietMs >= effectiveQuietMs * 1.5 && latest.sendDisabled === false) {
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
    `千问未在 ${budgetMs}ms 内结束生成。`,
    {
      stage: "generating",
      promptSubmitted: true,
      generating: latest?.generating ?? null,
      partialAnswer: latest && latest.answerLength > 200 ? latest.answer : null,
      // 这次超时时到底有没有见过答案。区分两种截然不同的超时：
      //   answerSeen 有值  -> 平台在慢慢生成（历史上见过 40–99 分钟的慢响应），是平台慢；
      //   answerSeen 为 0  -> 整个预算内一个字符都没渲染出来。
      // answerSeen 为 0 **不等于**平台拒绝回答：同一个 details 里的 generating=true 说明
      // 「停止生成」按钮还在页面上，平台是在生成、只是没在预算内写出东西。判断登录墙/风控要看
      // sessionSignals.login 与 loginSurfaceSelectors，不要拿这一位去推断额度。
      // 上层靠这一位判断要不要撤并发：并发的代价恰恰表现为后者，而前者撤并发没有帮助。
      answerSeen: latest?.answerLength ?? 0,
      budgetMs,
    },
  );
}

/**
 * 展开「N篇来源」并提取真正的来源列表。
 *
 * 这是获取**文章级来源**的唯一入口，2026-09-25 实测确认。
 *
 * 两个关键点，之前几轮都栽在这里：
 *
 * 1. **必须先 scrollIntoView 再点**。那个「N篇来源」元素在页面下方（实测 `top≈1310`，视口外），
 *    Playwright 的 `locator.click()` 会等它进入视口而超时 —— 我因此误判成「点不开」，
 *    甚至怀疑平台不暴露来源。用 `scrollIntoView({block:"center"}) + el.click()` 一次就开了。
 *
 * 2. **数据在 `data-click-extra` 属性里，不在文本或 href 里**。展开后每个来源是
 *    `div[data-c="refer_panel"]`（id 形如 `deep-think-source-card-{uuid}-{n}`），
 *    其 `data-click-extra` 是一段 JSON，带完整字段：
 *
 *      {"url":"https://www.meipian.cn/5nr0zu4n","title":"爱分享的沐沐的美篇",
 *       "ref_url":"https://www.meipian.cn/5nr0zu4n","refer_num":"1","display_scene":"answer_rag"}
 *
 *    所以既不是 `<a href>`（实测展开后 anchorCount 仍为 0），也不是纯文本。
 *
 * 没有这个按钮的答案（平台未触发深度搜索）返回空数组 —— 那不是失败，是平台没给。
 */
async function extractExpandedSources(page) {
  const clickExpander = () =>
    page
      .evaluate(() => {
        const norm = (v) => String(v || "").replace(/\s+/g, " ").trim();
        const el = [...document.querySelectorAll("div, span")].find(
          (node) => /^\d+篇来源$/.test(norm(node.innerText)) && getComputedStyle(node).cursor === "pointer",
        );
        if (!el) return false;
        el.scrollIntoView({ block: "center" });
        el.click();
        return true;
      })
      .catch(() => false);

  const readPanel = () =>
    page
      .evaluate(() => {
        const cards = [...document.querySelectorAll('[data-c="refer_panel"]')];
        const out = [];
        for (const card of cards) {
          let meta = null;
          try {
            meta = JSON.parse(card.getAttribute("data-click-extra") || "{}");
          } catch {
            meta = null;
          }
          const url = meta?.url || meta?.ref_url || null;
          if (!url) continue;
          out.push({ url, title: meta?.title || null, referNum: Number(meta?.refer_num) || null });
        }
        return out;
      })
      .catch(() => []);

  // 必须轮询，不能只试一次。这条路径在 submitAndWait 刚返回时被调用，那一刻答案文本虽然稳定了，
  // 但「N篇来源」按钮往往还没渲染出来 —— 实测线上批次因此一条 panel 都没采到（refer_panel=0），
  // 而同样是这份代码，在采集返回后再等 2.5 秒手动展开就成功。差的不是逻辑，是时机。
  let opened = false;
  const clickDeadline = Date.now() + 6_000;
  while (Date.now() < clickDeadline) {
    opened = await clickExpander();
    if (opened) break;
    await page.waitForTimeout(800);
  }
  if (!opened) return [];

  // 面板自身也是异步渲染的，同样轮询等条目出现。
  let sources = [];
  const readDeadline = Date.now() + 6_000;
  while (Date.now() < readDeadline) {
    sources = await readPanel();
    if (sources.length > 0) break;
    await page.waitForTimeout(800);
  }
  return sources;
}

/**
 *
 * 千问 self-reports a source count, so this surface uses the same counting tier as Doubao.
 * The reported number is of *materials*, while several links can collapse into one canonical
 * URL after de-duplication, so only "captured fewer than reported" is a mismatch - the other
 * direction is normal and must not be flagged.
 */
async function reconcileCitations(scan, context, page, profile, panelSources = []) {
  const seen = new Set();
  const citations = [];
  const discarded = { internalHost: 0, unparseable: 0, duplicate: 0 };

  // ── 第一路（最完整，优先）：展开后的来源面板 ─────────────────────────────
  //
  // 这是唯一给出**文章级 url + title** 的来源。放在最前面，让后面几路（DOM 链接、
  // 图标域名、答案文本）只做补充并自动去重。
  for (const source of panelSources) {
    const canonicalUrl = canonicalizeUrl(source.url) ?? source.url;
    if (!canonicalUrl || seen.has(canonicalUrl)) {
      if (canonicalUrl) discarded.duplicate += 1;
      continue;
    }
    seen.add(canonicalUrl);
    const host = domainFromUrl(canonicalUrl);
    citations.push({
      title: source.title || sourceLabel(host ?? ""),
      url: source.url,
      canonicalUrl,
      domain: host,
      sourcePosition: citations.length + 1,
      citationMarker: null,
      answerText: null,
      sourceType: "visible",
      capturedFrom: "refer-panel",
      visibleToUser: true,
      relationStatus: "matched",
    });
  }

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

  if (panelSources.length > 0) {
    diagnostics.push(`refer-panel:${panelSources.length}`);
  }

  // ── 第二路：引用 favicon 解码 ─────────────────────────────────────────────
  //
  // 这是实测找到的正解。之前几轮都在找「文本里的来源」和「可展开的列表」，都不对：
  // 千问把来源渲染成一排 favicon（`reference-wrap` 里的 `search-icon-item > img`），
  // 每个 img 的 src 是图片代理，`key=` 参数 base64 编码着原始 URL。
  // 正文里没有 URL、全页没有外链 —— 不解码这排图标就永远拿不到来源。
  const iconSources = decodeProxyImageSources(scan.referenceIconSources);
  const domMainText = [...seen];
  for (const icon of iconSources) {
    if (domMainText.includes(icon.url)) {
      discarded.duplicate += 1;
      continue;
    }
    domMainText.push(icon.url);
    citations.push({
      title: sourceLabel(icon.host),
      url: icon.url,
      canonicalUrl: icon.url,
      domain: icon.host,
      sourcePosition: citations.length + 1,
      citationMarker: null,
      answerText: null,
      // sourceType 必须是 'visible' 或 'retrieved' —— 同样不接受自创值。
      // 图标是页面上真实渲染出来的引用入口，用户看得见，所以是 visible 而不是 retrieved
      // （retrieved 的语义是「拿到了但无法确认 UI 可见」，用在这里会把语义弄反）。
      sourceType: "visible",
      capturedFrom: "reference-icon",
      visibleToUser: true,
      // 必须是 'matched' 或 'unresolved' —— schema 不认第三个值。
      // 我第一版写的 "resolved" 让整条 run 在落库时被拒（job-db-error），
      // 表现却是「引用抓不到」（captured=0），排查方向被误导了好几轮：
      // 采集其实成功了，是写不进数据库。
      // 图标解码是从 base64 里还原出确定 URL，不是模糊匹配，所以记 matched。
      relationStatus: "matched",
    });
  }
  if (iconSources.length > 0) diagnostics.push(`reference-icons:${iconSources.length}`);

  // 这里**不做**等待汇总卡的轮询。曾经加过一版 8 秒轮询，试图等 `data-card_name="bar_workflow"`
  // 延迟渲染出来，但实测那个元素在当前版页面上根本不存在（计数恒为 0）—— 等再久也读不到，
  // 只是把每条采集拖慢 8 秒。参考数改由答案文本解析提供（见下方 answerSources），
  // DOM 这条路只作为「万一拿到」的补充。
  for (const value of scan.countTexts ?? []) {
    const match = context.countPattern.exec(value);
    if (match) {
      // Group 2 is the 参考 M 篇资料 number; 千问 phrasing mirrors Doubao's.
      expectedCount = Number(match[2] ?? match[1]) || null;
      diagnostics.push("qianwen-self-reported-count");
      break;
    }
  }
  // 第三路：从答案文本解析出处块。
  //
  // 为什么必须有这一路：2026-09-24 实测确认千问已改版 —— 页面上**没有**采集器依赖的汇总卡
  // （`data-card_name` 元素计数为 0），来源链接也不以 `<a>` 呈现。DOM 这条路当前拿不到引用，
  // 但平台自述的出处块完整写在答案里（「已完成分析，共参考 N 篇资料 … 查看全部」）。
  // 文本解析零额外开销：答案本来就采到了。
  const answerSources = parseAnswerSources(scan.answer);
  if (answerSources.found) {
    diagnostics.push(`answer-source-block:${answerSources.titles.length}条`);
  }

  // 第四路：页面上的「N篇来源」折叠提示。
  //
  // 实测情况：千问改版后，出处块**不是每条答案都有**（同一次会话里，有的答案带完整的
  // 「已完成分析，共参考 N 篇资料 … 查看全部」，有的只有正文），但页面上那个「N篇来源」
  // 计数一直都在。它至少能回答「平台给了几条来源」，比什么都读不到强得多。
  // 中文数字也要认：页面上出现过「十篇来源」。
  const pageSourceCount = (() => {
    const match = String(scan.bodyText ?? "").match(/([0-9零一二三四五六七八九十百]+)\s*篇来源/);
    if (!match) return null;
    const raw = match[1];
    if (/^\d+$/.test(raw)) return Number(raw);
    const digits = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (raw === "十") return 10;
    if (raw.startsWith("十")) return 10 + (digits[raw[1]] ?? 0);
    if (raw.endsWith("十")) return (digits[raw[0]] ?? 0) * 10;
    return null;
  })();
  if (pageSourceCount !== null) diagnostics.push(`page-source-badge:${pageSourceCount}`);

  // 参考数的优先级：答案文本自述 > 页面折叠提示。前者精确到「参考了几篇资料」，
  // 后者是界面上给用户看的计数，两者通常一致，但文本里的更贴近平台自述。
  if (expectedCount === null && answerSources.sourceCount !== null) {
    expectedCount = answerSources.sourceCount;
    diagnostics.push("reference-count-from-answer-text");
  } else if (expectedCount === null && pageSourceCount !== null) {
    expectedCount = pageSourceCount;
    diagnostics.push("reference-count-from-page-badge");
  } else if (expectedCount === null) {
    diagnostics.push("reference-count-not-observed");
  }

  // 计入两路：DOM 拿到的链接 + 文本解析出的 URL 行。
  const captured = citations.length + (answerSources.urls?.length ?? 0);
  if (expectedCount !== null && captured < expectedCount) {
    diagnostics.push(`reference-count-mismatch:${captured}/${expectedCount}`);
  }
  if (citations.length === 0 && (answerSources.titles?.length ?? 0) === 0) {
    diagnostics.push("citations-wholly-unobserved");
  }

  // 「没观测到参考数」不能算 ok。旧判定 `expectedCount !== null && captured < expected` 在
  // expectedCount 为 null 时直接落到 ok —— 于是「连平台自报的数量都没读到」被标成了正常，
  // 实测就是靠这个漏洞掩盖了 84 条里 80 条读不到参考数的事实。
  const complete = expectedCount !== null && captured >= expectedCount;

  return {
    citations,
    expectedCount,
    diagnostics: [...new Set(diagnostics)],
    state: complete ? "ok" : "count_mismatch",
    answerSources,
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

  // 展开「N篇来源」拿文章级来源。放在 reconcileCitations 之前：展开会改动页面状态，
  // 而 reconcile 只读 scan 快照，顺序反过来会把已展开的面板算成「初始状态」。
  // 平台未触发深度搜索的答案没有这个按钮，此时返回空数组，不是错误。
  const panelSources = await extractExpandedSources(page);

  const citationResult = await reconcileCitations(scan, context, page, profile, panelSources);

  return {
    answer: scan.answer,
    citations: citationResult.citations,
    citationState: citationResult.state,
    expectedCitationCount: citationResult.expectedCount,
    citationDiagnostics: citationResult.diagnostics,
    // 出处块解析结果单独带出去：即使 DOM 一个链接都没给，平台自述的篇数与来源标题也在里面。
    // 下游（runs.citation_diagnostics）据此能区分「平台没给」与「我们没采到」。
    answerSources: citationResult.answerSources,
    citationCounts: {
      expected: citationResult.expectedCount,
      domLinks: (scan.links ?? []).length,
      textSources: citationResult.answerSources?.titles?.length ?? 0,
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
