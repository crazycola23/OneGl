const DOUBAO_DOM_ASSUMPTIONS = Object.freeze({
  answerSelectors: Object.freeze([
    ".md-box-root",
    '[class*="md-box-root"]',
    '[data-testid="message_text_content"]',
    '[data-testid="message_content"]',
    ".flow-markdown-body",
  ]),
  sourceBlockSelector: '[data-plugin-identifier*="block_type:10025"]',
  citationSignalSource: String.raw`搜索\s*(\d+)\s*个关键词[，,、\s]*参考\s*(\d+)\s*篇资料`,
  overlaySelector:
    '[role="dialog"], [aria-modal="true"], [class*="popover"], [class*="reference"]',
});

export async function captureDomObservation(page, { prompt = null } = {}) {
  const capturedAt = new Date().toISOString();
  const observation = await page.evaluate(
    ({ assumptions, prompt }) => {
      const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
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
      const text = (element, limit = 4_000) =>
        norm(element?.innerText || element?.textContent || "").slice(0, limit);
      const outer = (element, limit = 30_000) =>
        String(element?.outerHTML || "").slice(0, limit);
      const elementMeta = (element) => ({
        tag: element?.tagName?.toLowerCase?.() || null,
        id: element?.id || null,
        className:
          typeof element?.className === "string"
            ? element.className.slice(0, 1_000)
            : null,
        dataTestId: element?.getAttribute?.("data-testid") || null,
        pluginIdentifier:
          element?.getAttribute?.("data-plugin-identifier") || null,
        role: element?.getAttribute?.("role") || null,
        ariaLabel: element?.getAttribute?.("aria-label") || null,
        text: text(element),
        outerHTML: outer(element),
      });
      const linkRows = (root) =>
        [...(root?.querySelectorAll?.("a[href]") || [])]
          .filter(visible)
          .map((anchor) => ({
            title: norm(
              anchor.innerText ||
                anchor.getAttribute("aria-label") ||
                anchor.title ||
                "",
            ),
            href: anchor.href,
            marker: norm(anchor.innerText || anchor.textContent || ""),
          }))
          .filter((row) => external(row.href));

      const selectorStats = assumptions.answerSelectors.map((selector) => {
        const nodes = [...document.querySelectorAll(selector)];
        return {
          selector,
          count: nodes.length,
          visibleCount: nodes.filter(visible).length,
        };
      });

      const answerElements = [];
      for (const selector of assumptions.answerSelectors) {
        for (const element of document.querySelectorAll(selector)) {
          if (visible(element) && !answerElements.includes(element)) {
            answerElements.push(element);
          }
        }
      }
      const latestAnswer = answerElements.at(-1) || null;

      const signal = new RegExp(assumptions.citationSignalSource);
      const sourceBlocks = [
        ...document.querySelectorAll(assumptions.sourceBlockSelector),
      ]
        .filter(visible)
        .map((element, index) => {
          const sourceText = text(element);
          const match = sourceText.match(signal);
          const triggerCandidates = [
            ...element.querySelectorAll(
              '[data-copy-ignore].cursor-pointer, [data-copy-ignore][class*="cursor-pointer"], [role="button"], button',
            ),
          ]
            .filter(visible)
            .slice(0, 20)
            .map((trigger) => elementMeta(trigger));
          return {
            index,
            ...elementMeta(element),
            citationSignal: match
              ? {
                  keywordCount: Number(match[1]),
                  referenceCount: Number(match[2]),
                  raw: match[0],
                }
              : null,
            visibleExternalLinks: linkRows(element),
            triggerCandidates,
          };
        });

      const overlays = [
        ...document.querySelectorAll(assumptions.overlaySelector),
      ]
        .filter(visible)
        .slice(0, 20)
        .map((element, index) => ({
          index,
          ...elementMeta(element),
          visibleExternalLinks: linkRows(element),
        }));

      const inlineLinks = latestAnswer
        ? [...latestAnswer.querySelectorAll("a[href]")]
            .filter(visible)
            .filter((anchor) => external(anchor.href))
            .map((anchor, index) => ({
              index,
              href: anchor.href,
              marker: norm(
                anchor.innerText || anchor.getAttribute("aria-label") || "",
              ),
              relatedText: text(
                anchor.closest("p, li, blockquote") ||
                  anchor.parentElement ||
                  anchor,
                1_500,
              ),
              outerHTML: outer(anchor, 8_000),
            }))
        : [];

      const userCandidates = [
        ...document.querySelectorAll(
          '[class*="whitespace-pre-wrap"], [data-testid*="send_message"], [data-testid*="user"]',
        ),
      ].filter(visible);
      const userMessages = [];
      const seenUserText = new Set();
      for (const element of userCandidates) {
        const value = text(element, 2_000);
        if (!value || seenUserText.has(value)) continue;
        seenUserText.add(value);
        userMessages.push({
          text: value,
          dataTestId: element.getAttribute("data-testid") || null,
          className:
            typeof element.className === "string"
              ? element.className.slice(0, 500)
              : null,
        });
      }

      const modalTexts = [
        ...document.querySelectorAll(
          '[role="dialog"], [aria-modal="true"], .semi-modal, .modal, [role="alert"]',
        ),
      ]
        .filter(visible)
        .map((element) => text(element, 1_000));
      const hasVisible = (selector) =>
        [...document.querySelectorAll(selector)].some(visible);
      const routerLogin =
        window._ROUTER_DATA?.loaderData?.chat_layout?.userSetting?.data?.is_login;
      const captcha =
        hasVisible(
          'iframe[src*="captcha"], iframe[src*="verify"], iframe[src*="rmc"], input[placeholder*="验证码"], input[aria-label*="验证码"]',
        ) ||
        modalTexts.some((value) =>
          /人机验证|完成安全验证|滑动验证|拖动滑块/.test(value),
        );
      const login =
        routerLogin === false ||
        modalTexts.some((value) =>
          /扫码登录|请登录后使用|登录后继续|登录以解锁更多功能/.test(value),
        );
      const accessRestricted = modalTexts.some((value) =>
        /访问异常|访问受限|服务异常|当前访问人数过多|网络不给力/.test(value),
      );
      const generating = [...document.querySelectorAll('button, [role="button"]')]
        .filter(visible)
        .some((element) =>
          /停止生成|停止回答|停止/.test(
            `${element.getAttribute("aria-label") || ""} ${text(element, 200)}`,
          ),
        );

      const promptNorm = norm(prompt);
      const promptEchoCount = promptNorm
        ? userMessages.filter((message) => norm(message.text) === promptNorm).length
        : null;
      const conversationId =
        location.pathname.match(/\/chat\/([^/?#]+)/)?.[1] || null;

      return {
        url: location.href,
        title: document.title,
        conversationId,
        selectorStats,
        answer: {
          visibleNodeCount: answerElements.length,
          latest: latestAnswer ? elementMeta(latestAnswer) : null,
          inlineExternalLinks: inlineLinks,
        },
        sources: {
          visibleBlockCount: sourceBlocks.length,
          blocks: sourceBlocks,
        },
        overlays: {
          visibleCount: overlays.length,
          items: overlays,
        },
        conversation: {
          userMessages: userMessages.slice(-10),
          promptEchoCount,
          distinctVisibleUserMessageCount: userMessages.length,
        },
        sessionSignals: {
          routerLogin:
            typeof routerLogin === "boolean" ? routerLogin : null,
          captcha,
          login,
          accessRestricted,
          generating,
          visibleTextboxCount: [
            ...document.querySelectorAll(
              'textarea, [contenteditable="true"], [role="textbox"]',
            ),
          ].filter(visible).length,
          modalTexts,
        },
      };
    },
    {
      assumptions: DOUBAO_DOM_ASSUMPTIONS,
      prompt,
    },
  );

  return {
    capturedAt,
    assumptions: DOUBAO_DOM_ASSUMPTIONS,
    ...observation,
  };
}
