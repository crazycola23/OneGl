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

/**
 * Tailwind-style utilities are worse than hashed classes: they are layout, so any redesign
 * or copy change moves them, and the bracketed arbitrary-value form (`min-h-[24px]`) is a
 * one-off that only exists because of the current CSS. A first capture against qianwen.com
 * proposed `.min-h-[24px]` for the composer and `.inline-flex` for send, which is how a
 * profile full of junk selectors gets born.
 *
 * Matching is on the *leading* segment, because Tailwind names are hyphen compounds:
 * `inline-flex`, `flex-col`, `text-16`, `placeholder:text-disabled`.
 */
const TAILWIND_PREFIXES = new Set([
  "relative", "absolute", "fixed", "sticky", "inset", "top", "right", "bottom", "left",
  "isolate", "z", "order", "col", "row", "float", "clear", "table", "caption",
  "block", "inline", "flex", "grid", "contents", "hidden", "sr",
  "grow", "shrink", "basis", "justify", "items", "content", "self", "place",
  "overflow", "overscroll", "aspect", "size", "w", "h", "min", "max",
  "p", "px", "py", "pt", "pr", "pb", "pl", "ps", "pe",
  "m", "mx", "my", "mt", "mr", "mb", "ml", "ms", "me", "space", "gap",
  "origin", "translate", "rotate", "scale", "skew", "transform", "animate",
  "cursor", "touch", "select", "resize", "scroll", "snap", "pointer", "caret",
  "filter", "backdrop", "transition", "delay", "duration", "ease",
  "accent", "appearance", "columns", "decoration", "underline",
  "list", "indent", "align", "break", "whitespace", "text", "leading", "tracking",
  "font", "antialiased", "uppercase", "lowercase", "capitalize", "truncate",
  "bg", "from", "via", "to", "gradient", "opacity", "mix", "shadow", "ring",
  "border", "divide", "rounded", "outline", "offset",
  "visible", "invisible", "collapse", "static", "group", "peer",
]);

export function isHashBearingClass(token) {
  return HASH_TOKEN.test(String(token));
}

/**
 * Tailwind arbitrary variants (`min-h-[24px]`, `[&>*]:!cursor-not-allowed`) are a different
 * failure mode from build hashes: a hash has a stable prefix worth matching as a substring,
 * while an arbitrary variant has no stable part at all. Conflating the two made the probe
 * propose `[class*="[&>*]:!cursor-not"]` as 千问's send button.
 */
export function isArbitraryUtilityClass(token) {
  return /\[[^\]]*\]/.test(String(token));
}

export function isUtilityClass(token) {
  if (!token) return false;
  if (isArbitraryUtilityClass(token)) return true;
  // "utility" means Tailwind layout vocabulary, not "unstable". Hash-bearing names are a
  // separate failure mode that still has a usable fallback (see stableClassPart).
  return String(token)
    .split(/[:/]/)
    .some((segment) => {
      const parts = segment.split("-");
      if (TAILWIND_PREFIXES.has(parts[0])) return true;
      // a bare utility word followed by a bare number: `text-16`, `rounded-10`
      return /^\d+$/.test(parts.at(-1) ?? "") && parts.length > 1;
    });
}

/** A class is only worth selecting on if it is neither layout nor a build hash. */
export function isSelectableClass(token) {
  return Boolean(token) && !isUtilityClass(token) && !isHashBearingClass(token);
}

/** Radix/emotion runtime ids (`:ro:`) and short generated values are not stable identifiers. */
export function isVolatileDataValue(value) {
  const text = String(value ?? "");
  return !text || text.length <= 3 || /^:.*:$/.test(text) || /^[a-z0-9]{12,}$/i.test(text);
}

function stableClassPart(token) {
  const index = token.lastIndexOf("-");
  if (index > 0 && isHashBearingClass(token) && !isUtilityClass(token)) return token.slice(0, index);
  return null;
}
/** data-* keys that name what an element *is*, as opposed to how it is styled or focused. */
const SEMANTIC_DATA_KEY = /testid|qa|hook|editor|textbox|input|send|submit|composer|message|answer|citation|source|reference/i;

function semanticDataSelector(data = {}) {
  for (const [key, value] of Object.entries(data)) {
    if (!SEMANTIC_DATA_KEY.test(key)) continue;
    if (value === "" || value == null) return `[${key}]`;
    if (isVolatileDataValue(value)) continue;
    return `[${key}="${value}"]`;
  }
  return null;
}

/**
 * Preference order is deliberate. A semantic data-* attribute survives a restyle *and* a copy
 * change, so it outranks placeholder text: 千问's composer carries both
 * `data-slate-editor="true"` and `data-placeholder="向千问提问"`, and the copy is precisely the
 * string the product team rewrites. Class fallback is emitted as a substring match with the
 * hash stripped, because remote login already learned that `qrcode-DeN5Ny` breaks on the next
 * build (see the QR detection note in src/api/remote-auth.js).
 */
export function suggestSelector(entry) {
  if (entry.testid && !isVolatileDataValue(entry.testid)) return `[data-testid="${entry.testid}"]`;
  // A native <button> has an implicit role, so requiring an explicit role attribute threw away
  // 千问's only usable label: aria-label="发送消息" with no role= in the DOM.
  if (entry.aria) {
    return entry.role
      ? `[role="${entry.role}"][aria-label="${entry.aria}"]`
      : `[aria-label="${entry.aria}"]`;
  }
  const fromData = semanticDataSelector(entry.data);
  if (fromData) return fromData;
  if (entry.placeholder) return `[placeholder*="${entry.placeholder}"]`;
  const tokens = (entry.classTokens ?? []).filter(Boolean);
  const plain = tokens.find(isSelectableClass);
  if (plain) return `.${plain}`;
  const partial = tokens.map(stableClassPart).find(Boolean);
  return partial ? `[class*="${partial}"]` : null;
}

/**
 * The container that groups citation cards, inferred from what the off-site links actually
 * sit inside. Ranked by how many links it encloses, deepest shared ancestor first.
 */
export function suggestCitationBlocks(ancestors = []) {
  const bySelector = new Map();
  for (const chain of ancestors) {
    chain.forEach((node, depth) => {
      if (Number(node.linkCount) < 2) return;
      if (node.tag === "body" || node.tag === "html") return;
      const selector = suggestSelector({ data: node.data, classTokens: node.classTokens });
      if (!selector) return;
      const seen = bySelector.get(selector) ?? { selector, linkCount: 0, depth: 0 };
      seen.linkCount = Math.max(seen.linkCount, Number(node.linkCount));
      seen.depth = Math.max(seen.depth, depth);
      bySelector.set(selector, seen);
    });
  }
  return [...bySelector.values()].sort((a, b) => b.linkCount - a.linkCount).slice(0, 6);
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
  const anonymous = capture.requiresStoredAuth === false;

  if (anonymous) {
    // An anonymous surface has no login to measure, but the cap-vs-block distinction is now
    // the critical unknown: getting it wrong sleeps a campaign instead of escalating it.
    if (!capture.quotaSignalObserved) {
      questions.push("配额：未观测到平台的次数上限文案，exhaustedPatterns 与退避点无法确定");
    }
    if (!capture.controlPromptAnswered) {
      questions.push("配额：对照 prompt 未验证，无法区分「额度用完」与「访问受限/需验证」");
    }
  } else {
    if (!capture.hasLoggedIn) {
      questions.push("登录：未观测到登录后状态，session cookie 名单无法推导（匿名态的 CSRF/埋点 cookie 一律不算凭证）");
    }
    if (!capture.qrSurfaceObserved) {
      questions.push("登录：没有观测到扫码浮层。是手机号/密码路径吗？该路径需要人工输入验证码，属于安全边界决策");
    }
    if (capture.expiredQrObserved !== true) {
      questions.push("登录：二维码过期文案与刷新控件未观测，过期自愈无法实现");
    }
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
 *
 * `markers` is the important part: text you can already see on screen ("参考 10 篇资料",
 * "停止回答", "回答由 AI 生成") is the most reliable way to locate the container that owns a
 * feature, because it does not depend on any class or attribute surviving the next build.
 * Doubao's reference block was found exactly this way. The tightest matching element is the
 * one where no descendant also matches.
 */
export function collectPageSignals(markers = []) {
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
  // React chat UIs often identify the composer with a data-* attribute and nothing else; the
  // first qianwen.com capture returned a div whose only classes were Tailwind utilities, so
  // without this the probe has nothing real to offer.
  const dataAttributes = (element) => {
    const out = {};
    for (const attribute of element.attributes) {
      if (attribute.name.startsWith("data-")) out[attribute.name] = attribute.value.slice(0, 60);
    }
    return out;
  };
  const describe = (element) => ({
    tag: element.tagName.toLowerCase(),
    testid: element.getAttribute("data-testid") || element.getAttribute("data-testid".toUpperCase()) || null,
    data: dataAttributes(element),
    editable: element.isContentEditable || element.getAttribute("contenteditable") === "true" || null,
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

  /**
   * Citation cards are the one thing a GEO profile cannot guess: the link itself is easy, the
   * container that groups them is what "the reference block exists" is decided against. So
   * walk up from each off-site link and report what the ancestors are actually called.
   */
  const linkAncestors = [...document.querySelectorAll("a[href]")]
    .filter((element) => {
      try {
        return /^https?:$/.test(new URL(element.href).protocol);
      } catch {
        return false;
      }
    })
    .slice(0, 40)
    .map((element) => {
      const chain = [];
      let node = element.parentElement;
      for (let depth = 0; node && depth < 4; depth += 1) {
        chain.push({
          tag: node.tagName.toLowerCase(),
          data: dataAttributes(node),
          classTokens: tokens(node).slice(0, 6),
          linkCount: node.querySelectorAll("a[href]").length,
        });
        node = node.parentElement;
      }
      return chain;
    });

  let storageKeys = [];
  try {
    storageKeys = Object.keys(localStorage);
  } catch {
    storageKeys = [];
  }

  const markerHits = [];
  for (const pattern of Array.isArray(markers) ? markers : []) {
    let expression;
    try {
      expression = new RegExp(String(pattern), "i");
    } catch {
      continue;
    }
    const candidates = [...document.querySelectorAll("div, section, article, p, span, button")]
      .filter((element) => expression.test(element.innerText || element.textContent || ""))
      .filter((element) => {
        for (const child of element.querySelectorAll("div, section, article, p, span")) {
          if (expression.test(child.innerText || child.textContent || "")) return false;
        }
        return true;
      })
      .slice(0, 3);
    for (const element of candidates) {
      const ancestors = [];
      let node = element.parentElement;
      for (let depth = 0; node && depth < 5; depth += 1) {
        ancestors.push({
          tag: node.tagName.toLowerCase(),
          data: dataAttributes(node),
          classTokens: tokens(node).slice(0, 6),
        });
        node = node.parentElement;
      }
      markerHits.push({ pattern: String(pattern), ...describe(element), ancestors });
    }
  }

  return {
    url: location.href,
    title: document.title,
    // Bounded on purpose: quota and login-wall wording is near the top of a chat page, and an
    // untruncated dump would write whole answer bodies into the evidence file.
    pageText: (document.body?.innerText ?? "").replace(/\s+/g, " ").slice(0, 4_000),
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
    linkAncestors,
    markerHits,
    qrCandidates: [...all('[class*="qrcode" i], [class*="qr-code" i], canvas, svg')].map(describe),
    historyLength: history.length,
  };
}
