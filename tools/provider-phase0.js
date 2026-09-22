import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadConfig } from "../src/config.js";
import { launchBrowserSession } from "../src/browser.js";
import {
  captureOpenQuestions,
  collectPageSignals,
  externalLinkHosts,
  rankAnswerCandidates,
  suggestCitationBlocks,
  suggestSelector,
  suggestSelectors,
} from "../src/providers/phase0.js";
import { deriveSessionCookieCandidates } from "../src/providers/profile.js";
import { pendingProviderProfiles, providerProfileGaps } from "../src/providers/index.js";

/**
 * Measure a provider before believing it.
 *
 *   node tools/provider-phase0.js --profile yuanbao-web --stage anonymous
 *   node tools/provider-phase0.js --profile yuanbao-web --stage login
 *   node tools/provider-phase0.js --profile yuanbao-web --stage chat --prompt "..."
 *   node tools/provider-phase0.js --profile yuanbao-web --stage report
 *
 * Cookie *values* are never written anywhere - only their presence and length, which is all
 * the diff needs. Snapshots land under .onegl/phase0/ (git-ignored evidence, not fixtures).
 */

const args = process.argv.slice(2);
function flag(name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : null;
}
/** Repeatable: --marker "参考.*篇资料" --marker "停止回答" */
function flags(name) {
  const out = [];
  args.forEach((entry, index) => {
    if (entry === `--${name}`) out.push(args[index + 1]);
  });
  return out.filter(Boolean);
}

const profileId = flag("profile") ?? "yuanbao-web";
const stage = flag("stage") ?? "report";
const profile = pendingProviderProfiles.find((entry) => entry.id === profileId);
if (!profile) {
  console.error(`未知 profile：${profileId}。可选：${pendingProviderProfiles.map((p) => p.id).join(", ")}`);
  process.exit(1);
}

const snapshotDir = path.join(".onegl", "phase0");
const snapshotPath = (kind) => path.join(snapshotDir, `${profileId}.${kind}.json`);

async function readSnapshot(kind) {
  try {
    return JSON.parse(await readFile(snapshotPath(kind), "utf8"));
  } catch {
    return null;
  }
}

async function writeSnapshot(kind, payload) {
  await mkdir(snapshotDir, { recursive: true, mode: 0o700 });
  await writeFile(snapshotPath(kind), `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(`已写入 ${snapshotPath(kind)}`);
}

// Presence-only view, so the shared differ sees "empty -> non-empty" without ever holding a
// credential value on disk.
const cookieMap = (snapshot) =>
  Object.fromEntries((snapshot?.cookies ?? []).map((entry) => [entry.name, String(entry.valueLength ?? 0)]));

/**
 * `domcontentloaded` plus a fixed sleep is not enough on these SPAs. The first qianwen.com
 * capture saw 500 characters of body text and no composer, because the chat surface mounts
 * after the shell does. Doubao learned the same lesson in 287fad3 (wait for the composer to
 * mount before judging the front end), so the probe settles instead of guessing a duration.
 */
async function settlePage(page, { timeoutMs = 45_000, stableSamples = 2 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  let stable = 0;
  while (Date.now() < deadline) {
    const length = await page.evaluate(() => (document.body?.innerText ?? "").length).catch(() => 0);
    if (length === last) stable += 1;
    else {
      stable = 0;
      last = length;
    }
    if (stable >= stableSamples && last > 500) return last;
    await page.waitForTimeout(1_500);
  }
  return last;
}

/**
 * Diagnostic snapshot: what is actually blocking a submit. Reported at each step so the
 * failure is attributable instead of guessed at.
 */
async function diagnose(page) {
  return page.evaluate(() => {
    const overlay = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')]
      .filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0;
      })
      .map((element) => (element.innerText || "").replace(/\s+/g, " ").trim().slice(0, 80));
    const editor = document.querySelector('[data-slate-editor="true"]');
    const send = document.querySelector('[data-session-switch-target="send-query"]');
    const active = document.activeElement;
    return {
      overlays: overlay,
      editorPresent: Boolean(editor),
      editorText: (editor?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 60),
      editorChildEditable: editor?.querySelector("[data-slate-node]")?.getAttribute("contenteditable") ?? null,
      sendPresent: Boolean(send),
      sendDisabled: send ? send.disabled === true || send.getAttribute("aria-disabled") === "true" : null,
      sendClassHint: send ? /cursor-not-allowed/.test(send.className) : null,
      focused: active ? `${active.tagName.toLowerCase()}${active.getAttribute("data-slate-editor") ? "(slate)" : ""}` : null,
    };
  }).catch((error) => ({ error: String(error) }));
}

const MARKERS = flags("marker");
const gather = (page) => page.evaluate(collectPageSignals, MARKERS);

/**
 * Wait until the page stops looking like it is still generating.
 *
 * Text stability alone is not a completion criterion: one qianwen.com run stalled at a few
 * hundred characters of body text for the whole window while its "停止回答" control was still
 * up, because the deep-search phase produces no DOM growth. Providers that signal work with a
 * visible control need that control's absence instead.
 */
async function waitSettled(page, { timeoutMs, inProgress = null, minWaitMs = 20_000 } = {}) {
  const startedAt = Date.now();
  // 先给生成一点起步时间。刚点完发送就去查"进行中控件"，查到的必然是 0，
  // 于是会被判定成「已经完成」并在空答案上收尾 —— 第一次实测就是这么丢的答案。
  await page.waitForTimeout(6_000);
  let last = await settlePage(page, { timeoutMs: 20_000 });
  while (Date.now() - startedAt < timeoutMs) {
    const running = inProgress ? Number(await page.locator(inProgress).count().catch(() => 0)) : 0;
    if (!running && Date.now() - startedAt >= minWaitMs) return last;
    if (running) console.log("仍在生成中（命中进行中控件），继续等待…");
    await page.waitForTimeout(3_000);
    last = await settlePage(page, { timeoutMs: 10_000 });
  }
  console.log(`等待 ${timeoutMs}ms 超时，按当前状态收尾。`);
  return last;
}

async function capture({ ignoreStoredAuth = true, waitForLogin = false, prompt = null } = {}) {
  const config = loadConfig({ provider: profile.provider, headless: ignoreStoredAuth && !waitForLogin });
  const session = await launchBrowserSession(config, { ignoreStoredAuth, forceHeadful: waitForLogin });
  try {
    const page = session.page;
    await page.goto(profile.entryUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    const settledLength = await settlePage(page);
    console.log(`页面文本稳定在 ${settledLength} 字符。`);

    if (waitForLogin) {
      console.log("请在打开的窗口里完成登录（扫码或手机号）。本工具不代填、不解析验证码。");
      const deadline = Date.now() + 300_000;
      for (;;) {
        const signals = await gather(page);
        const diff = deriveSessionCookieCandidates(cookieMap(await readSnapshot("anonymous")), cookieMap(signals));
        if (diff.candidates.length) {
          console.log(`检测到 ${diff.candidates.length} 个登录后新增/变值的 cookie，停止等待。`);
          return { signals, diff, page };
        }
        if (Date.now() > deadline) {
          console.log("等待超时：没有观测到会话 cookie 变化。");
          return { signals, diff, page };
        }
        await page.waitForTimeout(3_000);
      }
    }

    if (prompt) {
      const composer = flag("composer");
      const send = flag("send");
      const sendKey = flag("send-key");
      const dismiss = flag("dismiss");
      // 千问的营销浮层会占住指针并吃掉回车：先 Esc，再点任意"关闭"，然后确认它真没了。
      await page.keyboard.press("Escape").catch(() => undefined);
      await page.locator(dismiss ?? 'button:has-text("关闭"), [aria-label="关闭"]').first()
        .click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(800);
      if (!composer) {
        console.error("chat 阶段需要 --composer <selector>，取值看 anonymous 阶段的 inputs。");
        return { signals: await gather(page), page };
      }
      console.log("清浮层后:", JSON.stringify(await diagnose(page)));
      const composerLocator = page.locator(composer).first();
      // 不用 force：force 会绕过命中检查，把事件打到仍盖在上面的浮层上，于是"点了编辑器"
      // 其实没拿到焦点。失败就如实报出来。
      await composerLocator.click({ timeout: 8_000 }).catch((error) => {
        console.log(`composer 点击失败: ${String(error).split("\n")[0]}`);
      });
      console.log("点 composer 后:", JSON.stringify(await diagnose(page)));
      // 逐字键入而不是 fill()：fill 只改 DOM，不触发 Slate/ProseMirror 的 input 处理，
      // 于是应用自己认为输入框还是空的，发送键永远禁用 —— 豆包的提交实现同样是多策略
      // 键入，不是 fill。
      await composerLocator.pressSequentially(prompt, { delay: 25 }).catch(async () => {
        await page.keyboard.insertText(prompt);
      });
      await page.waitForTimeout(1_500);
      const afterTyping = await gather(page);
      console.log("键入后:", JSON.stringify(await diagnose(page)));
      const sendAppeared = suggestSelectors(
        afterTyping.buttons.filter((entry) => /发送|send/i.test(`${entry.text} ${entry.aria ?? ""} ${entry.testid ?? ""}`)),
      );
      console.log(`键入后候选发送键：${sendAppeared.length ? sendAppeared.join(", ") : "仍无"}`);
      if (send) {
        await page.locator(send).first().click({ force: true }).catch(async () => {
          await page.locator(send).first().dispatchEvent("click");
        });
      } else if (sendKey) {
        // 很多对话站的发送键只在输入后出现，anonymous 首页看不到它 —— 用回车提交，
        // 才能把答案与引用区一并测出来。
        await page.keyboard.press(sendKey);
      } else {
        console.error("需要 --send <selector> 或 --send-key Enter 之一。");
        return { signals: await gather(page), page };
      }
      await waitSettled(page, {
        timeoutMs: Number(flag("wait") ?? 60_000),
        inProgress: flag("in-progress"),
      });
    }

    const signals = await gather(page);
    const cardSelector = flag("card");
    const cardDetails = cardSelector
      ? await page.evaluate((selector) => [...document.querySelectorAll(selector)].slice(0, 8).map((element, index) => ({
          index,
          tag: element.tagName.toLowerCase(),
          data: Object.fromEntries(
            [...element.attributes].filter((a) => a.name.startsWith("data-")).map((a) => [a.name, a.value.slice(0, 40)]),
          ),
          classTokens: [...element.classList].slice(0, 6),
          length: (element.innerText || "").trim().length,
          head: (element.innerText || "").replace(/\s+/g, " ").trim().slice(0, 70),
          externalLinks: [...element.querySelectorAll("a[href]")]
            .map((link) => { try { return new URL(link.href).hostname; } catch { return null; } })
            .filter((host, position, all) => host && all.indexOf(host) === position).slice(0, 12),
        })), cardSelector).catch(() => [])
      : [];
    return { signals, cardDetails, page };
  } finally {
    await session.close().catch(() => undefined);
  }
}

function summarize(signals, { prompt = null, previous = null, cardDetails = null } = {}) {
  const selfHost = (() => {
    try {
      return new URL(profile.entryUrl).hostname;
    } catch {
      return null;
    }
  })();
  return {
    at: new Date().toISOString(),
    url: signals.url,
    title: signals.title,
    historyLength: signals.historyLength,
    cookies: signals.cookies,
    localStorageKeys: signals.localStorageKeys,
    inputs: signals.inputs,
    buttons: signals.buttons.filter((entry) => entry.text || entry.testid || entry.aria),
    dialogs: signals.dialogs.map((entry) => entry.text).filter(Boolean).slice(0, 12),
    suggestedComposerSelectors: suggestSelectors(signals.inputs),
    suggestedSendSelectors: suggestSelectors(
      signals.buttons.filter((entry) => /发送|send/i.test(`${entry.text} ${entry.aria ?? ""} ${entry.testid ?? ""}`)),
    ),
    suggestedAnswerSelectors: rankAnswerCandidates(signals.textBlocks, prompt).map((entry) => ({
      selector: suggestSelectors([entry])[0] ?? null,
      length: entry.length,
      sample: entry.text.slice(0, 80),
    })),
    citationCardHosts: externalLinkHosts(signals.links, selfHost ? [selfHost] : []),
    citationBlockCandidates: suggestCitationBlocks(signals.linkAncestors),
    // Which repeated card holds the assistant answer, and how the user's own bubble differs.
    // Getting this wrong is what makes brand detection fire on our own question.
    cardBlocks: cardDetails ?? [],
    markerHits: (signals.markerHits ?? []).map((hit) => ({
      pattern: hit.pattern,
      selector: suggestSelector({ data: hit.data, classTokens: hit.classTokens, role: hit.role, aria: hit.aria }),
      text: hit.text,
      classTokens: hit.classTokens,
      data: hit.data,
      ancestors: (hit.ancestors ?? []).map((node) => ({
        tag: node.tag,
        selector: suggestSelector({ data: node.data, classTokens: node.classTokens }),
        classTokens: node.classTokens,
        data: node.data,
      })),
    })),
    qrSurfaceObserved: signals.qrCandidates.some((entry) => entry.width >= 80 && entry.height >= 80),
    loginSurfaceText: signals.dialogs
      .map((entry) => entry.text)
      .filter((text) => /登录|扫码/.test(text))
      .slice(0, 4),
    // A probe-time search aid so an operator knows *whether* to go look, not a selector to
    // ship: the wording that actually lands in a profile comes from reading the real text.
    quotaTextObserved: /剩余|体验次数|次数用完|今日.{0,6}(次数|限额)|过于频繁|请(?:稍后|明天)/.test(
      signals.pageText ?? "",
    ),
    loginWallObserved: /请先登录|登录后可|登录后继续|扫码登录/.test(signals.pageText ?? ""),
    pageTextLength: (signals.pageText ?? "").length,
    // The no-answer state is exactly the case that needs reading, so keep an excerpt. Without
    // it a run that produced nothing is indistinguishable from a run that hit a cap.
    pageTextExcerpt: (signals.pageText ?? "").slice(0, 1_200),
    cookieDiffAgainstAnonymous: previous
      ? deriveSessionCookieCandidates(cookieMap(previous), cookieMap(signals)).candidates
      : null,
  };
}

if (stage === "anonymous") {
  const { signals } = await capture({ ignoreStoredAuth: true });
  await writeSnapshot("anonymous", summarize(signals));
} else if (stage === "login") {
  if (profile.requiresStoredAuth === false) {
    console.error(`${profileId} 是匿名面（requiresStoredAuth: false），没有登录态可测。改跑 --stage chat。`);
    process.exit(1);
  }
  const anonymous = await readSnapshot("anonymous");
  if (!anonymous) {
    console.error("先跑 --stage anonymous，否则无法分辨哪些 cookie 是登录之后才出现的。");
    process.exit(1);
  }
  const { signals } = await capture({ waitForLogin: true });
  await writeSnapshot("logged-in", summarize(signals, { previous: anonymous }));
} else if (stage === "chat") {
  const prompt = flag("prompt");
  if (!prompt) {
    console.error("chat 阶段需要 --prompt \"...\"，建议用一条明显会触发联网引用的问题。");
    process.exit(1);
  }
  // 匿名面本来就没有登录态，不去读任何账号凭据文件。
  const { signals, cardDetails } = await capture({
    ignoreStoredAuth: profile.requiresStoredAuth === false,
    prompt,
  });
  await writeSnapshot("chat", summarize(signals, { prompt, cardDetails }));
} else if (stage === "report") {
  const [anonymous, loggedIn, chat] = await Promise.all([
    readSnapshot("anonymous"),
    readSnapshot("logged-in"),
    readSnapshot("chat"),
  ]);
  if (!anonymous) {
    console.error(`还没有任何观测记录：${snapshotPath("anonymous")} 不存在。`);
    process.exit(1);
  }
  const observed = {
    requiresStoredAuth: profile.requiresStoredAuth,
    hasLoggedIn: Boolean(loggedIn?.cookieDiffAgainstAnonymous?.length),
    qrSurfaceObserved: Boolean(chat?.qrSurfaceObserved ?? anonymous?.qrSurfaceObserved),
    expiredQrObserved: null,
    quotaSignalObserved: Boolean(chat?.quotaTextObserved ?? anonymous?.quotaTextObserved),
    controlPromptAnswered: false,
    loginWallObserved: Boolean(anonymous?.loginWallObserved),
    answerCandidates: chat?.suggestedAnswerSelectors ?? [],
    selfReportedCitationCount: undefined,
    conversationUrlObserved: Boolean(chat && chat.url !== anonymous.url),
  };

  console.log(`\n=== ${profileId} Phase 0 结论 ===`);
  console.log(`档案还缺 ${providerProfileGaps(profileId).length} 项才能注册为 adapter：`);
  for (const gap of providerProfileGaps(profileId)) console.log(`  - ${gap}`);
  console.log("\n观测到的登录态候选：");
  for (const entry of loggedIn?.cookieDiffAgainstAnonymous ?? []) {
    console.log(`  ${entry.name}  匿名=${entry.anonymousValue ?? "(无)"} → 登录后长度 ${entry.loggedInValue}`);
  }
  console.log("\n答案容器候选（按文本长度）：");
  for (const entry of chat?.suggestedAnswerSelectors ?? []) {
    console.log(`  ${entry.selector ?? "(无法生成稳定选择器)"}  len=${entry.length}  ${entry.sample}`);
  }
  console.log("\n站外链接主机（引用卡候选）：");
  for (const entry of (chat ?? anonymous).citationCardHosts.slice(0, 10)) {
    console.log(`  ${entry.host} × ${entry.count}`);
  }
  console.log(`\n观测到额度文案：${observed.quotaSignalObserved ? "有" : "无"}；登录墙文案：${observed.loginWallObserved ? "有" : "无"}`);
  console.log("\n仍需人工确认：");
  for (const question of captureOpenQuestions(observed)) console.log(`  ! ${question}`);
} else {
  console.error(`未知 stage：${stage}`);
  process.exit(1);
}
