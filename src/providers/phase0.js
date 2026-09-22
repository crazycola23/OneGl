/**
 * Phase 0 measurement for a new provider.
 *
 * Nothing in here guesses. The collector below reports what a real page exposed, and the
 * pure functions in this file turn that report into selector suggestions an operator reviews
 * before any of it enters a profile. A guessed session cookie is how an anonymous visit gets
 * recorded as a successful login; a guessed citation selector is how "we could not read it"
 * silently becomes "the platform cited nothing".
 */

/** CSS-module / emotion / styled-components style build hashes. Never stable enough to select on. */
const HASH_TOKEN = /(?:^css-|^[a-z][a-z0-9-]*-[A-Za-z0-9_]{5,}$|[A-Za-z0-9]{8,}$)/;

export function isHashBearingClass(token) {
  return HASH_TOKEN.test(token);
}

function stableClassPart(token) {
  const index = token.lastIndexOf("-");
  if (index > 0 && isHashBearingClass(token)) return token.slice(0, index);
  return null;
}

/**
 * Preference order is deliberate: data-testid and aria survive a restyle, a class survives a
 * copy change, and visible text is the least brittle thing on a chat page. Class fallback is
 * emitted as a substring match with the hash stripped, because remote login already learned
 * that `qrcode-DeN5Ny` breaks on the next build (see the QR detection note in
 * src/api/remote-auth.js).
 */
export function suggestSelector(entry) {
  if (entry.testid) return `[data-testid="${entry.testid}"]`;
  if (entry.role && entry.aria) return `[role="${entry.role}"][aria-label="${entry.aria}"]`;
  if (entry.placeholder) return `[placeholder*="${entry.placeholder}"]`;
  const tokens = (entry.classTokens ?? []).filter(Boolean);
  const plain = tokens.find((token) => !isHashBearingClass(token));
  if (plain) return `.${plain}`;
  const partial = tokens.map(stableClassPart).find(Boolean);
  return partial ? `[class*="${partial}"]` : null;
}

export function suggestSelectors(entries) {
  const seen = new Set();
  const out = [];
  for (const entry of entries ?? []) {
    const selector = suggestSelector(entry);
    if (!selector || seen.has(selector)) continue;
    seen.add(selector);
    out.push(selector);
  }
  return out;
}

/**
 * Answer containers ranked by how much text they hold. Longest-first is the whole heuristic:
 * on a chat page the assistant bubble is the biggest text node that is not the user's own
 * prompt, and getting this wrong is what makes brand detection fire on the question.
 */
export function rankAnswerCandidates(textBlocks = [], promptText = null) {
  const needle = typeof promptText === "string" ? promptText.trim() : null;
  return textBlocks
    .filter((block) => Number(block.length) > 40)
    .filter((block) => !needle || !String(block.text ?? "").startsWith(needle))
    .sort((a, b) => Number(b.length) - Number(a.length))
    .slice(0, 8);
}

/** Distinct hosts among visible links, which is where citation cards usually surface. */
export function externalLinkHosts(links = [], selfHosts = []) {
  const self = new Set(selfHosts.map((host) => String(host).toLowerCase()));
  const counts = new Map();
  for (const link of links) {
    const host = String(link.host ?? "").toLowerCase();
    if (!host || self.has(host)) continue;
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([host, count]) => ({ host, count }));
}

/**
 * What a capture still has to answer before the profile is real. Kept separate from
 * collectProfileErrors so the operator sees "what Phase 0 must decide", not a schema complaint.
 */
export function captureOpenQuestions(capture = {}) {
  const questions = [];
  if (!capture.hasLoggedIn) {
    questions.push("登录：未观测到登录后状态，session cookie 名单无法推导（匿名态的 CSRF/埋点 cookie 一律不算凭证）");
  }
  if (!capture.qrSurfaceObserved) {
    questions.push("登录：没有观测到扫码浮层。是手机号/密码路径吗？该路径需要人工输入验证码，属于安全边界决策");
  }
  if (capture.expiredQrObserved !== true) {
    questions.push("登录：二维码过期文案与刷新控件未观测，过期自愈无法实现");
  }
  if (!capture.answerCandidates?.length) {
    questions.push("抓取：没有稳定的答案容器候选");
  }
  if (capture.selfReportedCitationCount === undefined) {
    questions.push("抓取：平台是否自陈引用数量未确认。未确认前 citation.tier 必须是 dom-only");
  }
  if (!capture.conversationUrlObserved) {
    questions.push("抓取：会话 URL 形态未观测，无法建立 conversation 隔离判据与检索证据 turn scope");
  }
  return questions;
}

/**
 * Runs inside page.evaluate, so it must not close over anything from this module.
 * It only reports what is on the page; every judgement happens in Node above.
 */
export function collectPageSignals() {
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
  const tokens = (element) => [...element.classList].map((token) => String(token));
  const describe = (element) => ({
    tag: element.tagName.toLowerCase(),
    testid: element.getAttribute("data-testid") || element.getAttribute("data-testid".toUpperCase()) || null,
    role: element.getAttribute("role") || null,
    aria: element.getAttribute("aria-label") || null,
    placeholder: element.getAttribute("placeholder") || null,
    classTokens: tokens(element),
    text: (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160),
    width: Math.round(element.getBoundingClientRect().width),
    height: Math.round(element.getBoundingClientRect().height),
  });
  const all = (selector) => [...document.querySelectorAll(selector)].filter(visible);

  const cookieNames = document.cookie
    .split(";")
    .map((entry) => {
      const index = entry.indexOf("=");
      return index < 0
        ? { name: entry.trim().toLowerCase(), valueLength: 0 }
        : {
            name: entry.slice(0, index).trim().toLowerCase(),
            valueLength: entry.slice(index + 1).trim().length,
          };
    })
    .filter((entry) => entry.name);

  const links = [...document.querySelectorAll("a[href]")]
    .map((element) => {
      try {
        const url = new URL(element.href);
        return { host: url.hostname, path: url.pathname.slice(0, 40), ...describe(element) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  let storageKeys = [];
  try {
    storageKeys = Object.keys(localStorage);
  } catch {
    storageKeys = [];
  }

  return {
    url: location.href,
    title: document.title,
    cookies: cookieNames,
    localStorageKeys: storageKeys,
    inputs: [
      ...all('textarea, [contenteditable="true"], [role="textbox"], input[type="text"], input[type="tel"]'),
    ].map(describe),
    buttons: [...all("button, [role=button]")].map(describe),
    dialogs: [...all('[role="dialog"], [aria-modal="true"], .modal')].map(describe),
    textBlocks: [...all("div, section, article")].map((element) => ({
      ...describe(element),
      length: (element.innerText || element.textContent || "").trim().length,
    })),
    links,
    qrCandidates: [...all('[class*="qrcode" i], [class*="qr-code" i], canvas, svg')].map(describe),
    historyLength: history.length,
  };
}
