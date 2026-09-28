import { DoubaoMvpError, ErrorCode } from "./errors.js";

/**
 * 智谱清言（chatglm.cn）匿名面 driver。
 *
 * 全部行为来自 2026-09-27 在本地 Camoufox 出货引擎上的实测，记录见
 * `docs/ZHIPU_PHASE0.md`。**没有一项是从豆包或千问类比来的** —— 那是
 * `docs/MULTI_PLATFORM_LESSONS.md` §1/§2 记着的两次翻车原因。
 *
 * 与千问 driver 的关键差异（不是偷懒，是平台事实不同）：
 *   - 千问提交后 URL 会变成 `/chat/<id>`，那个 id 是样本可回查的凭据；
 *     智谱实测 URL 始终停在 `/main/alltoolsdetail?lang=zh`，**没有会话 id**。
 *     所以这里不做"拿不到 conversationId 就判失败"那一步 —— 判了就是
 *     把一个平台特性当成故障。它改为记录 URL，供事后核对。
 *   - 千问答案有 `message-card` / `answer-common-card` 类名；智谱答案是裸 `<p>`，
 *     同页还有一个更长的页脚 `policy-wrap`。答案定位必须显式排除页脚。
 */

/** 实测得到的控件选择器。集中在这里，便于平台改版时一处对齐。 */
const SELECTORS = {
  composer: "textarea",
  userBubble: '[class*="question-txt"]',
  // 页面级噪声：这些容器不是答案，必须在取答案前排除。
  // policy-wrap 是页脚（内容由AI生成…京ICP备…），实测 101 字符，比答案还长。
  answerNoise: ".policy-wrap, .title, .conversation-name, footer, nav, [class*='footer']",
};

/** 打开页面并让输入框处于可提交状态。 */
export async function openZhipu(page, config, profile) {
  await page
    .goto(profile.entryUrl, { waitUntil: "domcontentloaded", timeout: config.timeoutMs ?? 60_000 })
    .catch(() => undefined);
  await page.waitForTimeout(3_000);

  // ⚠️ 先判风控，再判弹层。
  //
  // 智谱对同一出口 IP 的高频匿名访问会返回「访问验证」页：页面 DOM 里 textarea 仍然
  // 存在，但尺寸是 0x0（实测），所以任何按元素存在性或可点性做的判断都会误报成
  // 「弹层没关掉」。而这两种情况需要**相反**的处置：弹层要清掉后继续，验证墙只能等平台
  // 自己放行。早先没分开判的后果是撞墙时抛 PAGE_CHANGED，worker 按「页面结构错乱」
  // 重试三次 —— 每次都再撞一次，把窗口彻底堵死，而日志指向的原因还是错的。
  const gate = await pageGate(page);
  if (gate.blocked) {
    throw new DoubaoMvpError(
      gate.kind === "verification" ? ErrorCode.VERIFICATION_REQUIRED : ErrorCode.ACCESS_RESTRICTED,
      gate.message,
      { stage: "open", url: page.url(), gate: gate.kind, ...gate.details },
    );
  }

  // 新手引导弹层（el-dialog.claw-guide-dialog）会盖住输入框。
  // 它的关闭按钮 button.close-btn 既没有文字也没有 aria-label，只按可见文字找
  // 必然失配 —— 实测就是这个坑。所以按多条独立路径尝试，并且**验证弹层真的消失**，
  // 不假设点击生效了。
  await dismissGuideDialog(page);

  // ⚠️ 这里**不能**只判断「overlay 数量为 0」就认为输入框可用。
  // 智谱是 SPA，新手引导是延迟注入的：openPage 检查的那一刻弹层可能还没渲染，
  // 计数为 0；等真正去点输入框时它才出现并拦截指针。
  // 实测栽过两次：第一次是「点了关闭按钮就返回」，第二次是「overlay 为 0 就返回」——
  // 两者都会让下一步的 click 超时，而错误信息指向输入框，真正的原因在弹层上。
  //
  // 唯一可信的判据是**输入框本身可点**：它由「有没有东西盖在上面」直接决定。
  const composer = page.locator(SELECTORS.composer).first();
  const ready = await waitForUsableComposer(page, composer);
  if (!ready) {
    // 到这一步仍不可点，重新判一次墙：弹层清除过程本身要花时间，墙可能在这期间落下。
    const late = await pageGate(page);
    if (late.blocked) {
      throw new DoubaoMvpError(
        late.kind === "verification" ? ErrorCode.VERIFICATION_REQUIRED : ErrorCode.ACCESS_RESTRICTED,
        late.message,
        { stage: "open", url: page.url(), gate: late.kind, ...late.details },
      );
    }
    throw new DoubaoMvpError(
      ErrorCode.PAGE_CHANGED,
      "智谱清言输入框不可提交（引导弹层未关闭或页面结构变化），匿名采集无法开始。",
      { stage: "open", url: page.url(), overlays: await overlayCount(page) },
    );
  }
  return page;
}

/**
 * 判断页面当前被什么挡住。
 *
 * 区分三件事，因为它们要不同的处置：
 *   - verification：平台返回的「访问验证」页，只能等它自己放行
 *   - login_wall：登录墙，匿名面已不可用
 *   - clear：可以继续
 *
 * 判据用**正文文案 + 输入框尺寸**，不用元素存在性：验证墙页面里 textarea 仍然在
 * DOM 中，只是被压成 0x0，所以「元素是否存在」完全区分不出来。
 */
async function pageGate(page) {
  const state = await page
    .evaluate(() => {
      const ta = document.querySelector("textarea");
      const r = ta ? ta.getBoundingClientRect() : null;
      const body = document.body.innerText || "";
      const m = body.match(/访问验证[^\n]{0,80}/);
      return {
        hasComposer: !!ta,
        composerW: r ? Math.round(r.width) : 0,
        composerH: r ? Math.round(r.height) : 0,
        verification: /访问验证|请进行验证|滑动验证|人机验证/.test(body),
        verificationText: m ? m[0].trim() : "",
        loginWall: /登录后?(继续|才能|解锁)|请先登录|扫码登录|登录解锁完整功能/.test(body),
      };
    })
    .catch(() => null);
  if (!state) return { blocked: false, kind: "unknown" };

  if (state.verification) {
    return {
      blocked: true,
      kind: "verification",
      message:
        `智谱清言返回访问验证页（${state.verificationText || "访问验证"}），`
        + "本次出口已被平台风控；应退避等待其自行放行，不要立即重试",
      details: { composerW: state.composerW, composerH: state.composerH },
    };
  }
  if (state.hasComposer && state.composerW === 0 && state.composerH === 0) {
    // 0x0 的输入框不是「弹层挡着」：弹层是可点的遮挡，输入框本身仍有尺寸。
    return {
      blocked: true,
      kind: "verification",
      message: "智谱清言输入框被压成 0x0，页面处于风控验证状态；应退避等待，不要立即重试",
      details: { loginWall: state.loginWall },
    };
  }
  if (state.loginWall && !state.hasComposer) {
    return {
      blocked: true,
      kind: "login_wall",
      message: "智谱清言匿名面已被登录墙取代（需要登录才能继续），本次采集无法开始",
      details: {},
    };
  }
  return { blocked: false, kind: "clear" };
}

/**
 * 等输入框真正可提交。
 *
 * 判据是 **DOM 事实**，不是 Playwright 的 trial click。
 *
 * 早先用的是 `click({ trial: true })`，它会做一整套动作性检查（滚动、稳定性、命中测试）。
 * 在出货的 Camoufox 上这套检查判定失败，而 DOM 证据显示**根本没有东西遮挡**：
 * 2026-09-28 在服务器容器内实测，输入框 774x68、视口 1440x900、
 * `document.elementFromPoint(中心点)` 返回的就是 `textarea` 本身、页面上零个
 * 可见 overlay。trial click 仍然拒绝，于是每一轮采集都死在
 * 「输入框不可点击」，而真实原因是判定方式在这个引擎上不成立。
 *
 * 换成的判据是可复核的三条：
 *   1) 输入框存在且有非零尺寸（排除风控页把它压成 0x0）
 *   2) 中心点的命中测试落在输入框或其后代上（排除被遮挡）
 *   3) 上面的风控 / 登录墙判定不成立
 *
 * 三条都满足就直接 focus + 键盘输入，不去按 Playwright 的可点性。
 */
async function waitForUsableComposer(page, composer, { timeoutMs = 20_000, stepMs = 1_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let last = null;
  while (Date.now() < deadline) {
    attempts += 1;
    last = await composerUsability(page);
    if (last.usable) return true;
    // 不可用就再清一次弹层：它可能是在上一次检查之后才注入的。
    await dismissGuideDialog(page);
    await page.waitForTimeout(stepMs);
  }
  console.warn(
    `[zhipu] 输入框在 ${timeoutMs}ms 内始终不可提交（清弹层 ${attempts} 轮）：`
    + `exists=${last?.exists} size=${last?.w}x${last?.h} hit=${last?.hitSelf}`,
  );
  return false;
}

/** 输入框的可用性，由页面自己回答。 */
async function composerUsability(page) {
  return page
    .evaluate(() => {
      const ta = document.querySelector("textarea");
      if (!ta) return { exists: false, w: 0, h: 0, hitSelf: false, usable: false };
      const r = ta.getBoundingClientRect();
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      if (w === 0 || h === 0) return { exists: true, w, h, hitSelf: false, usable: false };
      // 命中测试：中心点最上层的元素必须落在输入框自己或它的后代上。
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      const hitSelf = Boolean(top && (top === ta || ta.contains(top)));
      return { exists: true, w, h, hitSelf, usable: hitSelf };
    })
    .catch(() => ({ exists: false, w: 0, h: 0, hitSelf: false, usable: false }));
}

async function overlayCount(page) {
  return page
    .evaluate(
      () =>
        [...document.querySelectorAll(".el-overlay, .el-dialog, [role='dialog']")].filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        }).length,
    )
    .catch(() => -1);
}

/**
 * 关闭新手引导。
 *
 * 返回 true 表示弹层确实不再遮挡；false 表示仍有 overlay。
 * 「点了关闭按钮」不等于「弹层没了」——Element Plus 有淡入淡出，
 * 提前返回会让下一步的点击仍然被拦截。实测第一版就是栽在这里。
 */
async function dismissGuideDialog(page) {
  const paths = [
    async () => page.get_by_text("我知道了", { exact: true }).first,
    async () => page.get_by_text("知道了", { exact: true }).first,
    async () => page.locator("button.close-btn").first,
    async () => page.locator(".el-dialog button").first,
  ];
  for (const resolve of paths) {
    const has = await resolve()
      .then(async (loc) => (await loc.count()) > 0 && (await loc.isVisible().catch(() => false)))
      .catch(() => false);
    if (!has) continue;
    await resolve()
      .then((loc) => loc.click({ timeout: 3_000 }))
      .catch(() => undefined);
    // 等淡出动画走完再判定，否则 overlay 还在但已被标记为不可见。
    await page.waitForTimeout(1_200);
    if ((await overlayCount(page)) === 0) return true;
  }
  // 兜底：真人会按 Escape。
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(1_200);
  return (await overlayCount(page)) === 0;
}

/**
 * 切到一段干净的新对话。
 *
 * 判据是**提问气泡被清空**，不是「点了新对话」：智谱的按钮点击不保证立刻清空上下文，
 * 而只要上一条提问还在，新题就会落进同一段对话。豆包的 driver 用的是同一个思路
 * （`clickedNewConversation` + `resetConfirmed` 两个字段），这里沿用它的口径。
 */
async function startFreshConversation(page, { attempts = 3 } = {}) {
  const bubbles = () => page.locator(SELECTORS.userBubble).count().catch(() => 0);

  // 平台明确提示过「请等待其他对话生成完毕」：上一题还在生成时新题会被丢弃。
  // 所以先等它空闲，再谈切换 —— 否则即使点了「新对话」，发出去的也可能还是被拒。
  const busy = await page
    .evaluate(() => /请等待其他对话生成完毕|生成中/.test(document.body.innerText || ""))
    .catch(() => false);
  if (busy) {
    console.warn("[zhipu] 上一题仍在生成，先等待平台空闲再提问");
    for (let i = 0; i < 40; i += 1) {
      await page.waitForTimeout(3_000);
      const stillBusy = await page
        .evaluate(() => /请等待其他对话生成完毕|生成中/.test(document.body.innerText || ""))
        .catch(() => false);
      if (!stillBusy) break;
    }
  }

  if ((await bubbles()) === 0) return { ok: true, attempts: 0 };

  const targets = [
    () => page.getByRole("button", { name: "新对话", exact: true }).first,
    () => page.getByText("新对话", { exact: true }).first,
    () => page.locator("[class*='new-chat'], [class*='newChat']").first,
  ];

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    for (const resolve of targets) {
      const target = resolve();
      const usable = await target
        .count()
        .then((n) => n > 0)
        .then((has) => (has ? target.isVisible({ timeout: 1_500 }).catch(() => false) : false))
        .catch(() => false);
      if (!usable) continue;
      await target.click({ timeout: 3_000 }).catch(() => undefined);
      // 等上下文真的清掉再返回。早退会让新题落进旧对话 —— 症状是读回上一题的答案。
      for (let i = 0; i < 10; i += 1) {
        await page.waitForTimeout(400);
        if ((await bubbles()) === 0) return { ok: true, attempts: attempt };
      }
    }
  }
  return { ok: false, attempts };
}

/** 提交一条提问并等待回答成形。 */
export async function executeZhipuPrompt(page, prompt, config, profile) {
  const timeoutMs = config.timeoutMs ?? 180_000;
  const pollMs = config.pollMs ?? 3_000;

  // ⚠️ 必须在提问**之前**换到干净会话。profile 声明了 promptsPerWindow: 1，
  // 那个声明只有 driver 真的重置会话才成立；不重置就是「profile 承诺了 driver
  // 没兑现的事」—— 而后果不是报错，是**采到错答案**：
  // 平台在上一题还在生成时收到新题会提示「请等待其他对话生成完毕」，新题被丢弃，
  // 于是这一轮读到的是上一题的尾巴。实测：问完「新能源汽车销量排名」紧接着问
  // 「局域网和广域网的区别」，后者读回来的是比亚迪/吉利/特斯拉的销量数字，
  // 而且看起来完全正常 —— 这类错配比直接失败危险得多。
  const reset = await startFreshConversation(page);
  if (!reset.ok) {
    throw new DoubaoMvpError(
      ErrorCode.CONVERSATION_RESET_FAILED,
      "智谱清言未能切换到新对话，提问会落进上一段上下文并读回错误答案。",
      { stage: "conversation", url: page.url(), attempts: reset.attempts },
    );
  }

  const composer = page.locator(SELECTORS.composer).first();
  // 聚焦用 DOM focus() 而不是 Playwright 的 click：后者带指针命中判定，而实测在
  // Camoufox 上判定不成立（DOM 显示输入框可见且无人遮挡，click 仍超时）。
  // focus() 走的是元素自身的 focus 事件，与指针无关。
  await composer.evaluate((el) => el.focus());
  await composer.type(prompt, { delay: 40 });

  // 发送控件是纯 SVG，无 class / 无 aria-label / 无文字，所有文本启发式都提不出来。
  // 实测 Enter 可提交，所以走键盘路径 —— 这不是兜底，这是该平台唯一测通的路径。
  const before = page.url();
  await composer.press("Enter");

  const settled = await waitForAnswer(page, { timeoutMs, pollMs });
  if (!settled.answer) {
    // 没读到正文时必须说清是哪一类：被墙拦 / 页面变了 / 真的没产出。
    const wall = await loginWallVisible(page);
    if (wall) {
      throw new DoubaoMvpError(
        ErrorCode.LOGIN_REQUIRED,
        "智谱清言匿名额度或风控已触发登录墙，样本未产出。",
        { stage: "answer", url: page.url() },
      );
    }
    throw new DoubaoMvpError(
      ErrorCode.ANSWER_NOT_FOUND,
      "智谱清言提交后未读到回答正文。",
      {
        stage: "answer",
        url: page.url(),
        before,
        waitedMs: settled.waitedMs,
        lastLength: settled.lastLength,
      },
    );
  }

  return {
    answer: settled.answer,
    // 智谱把来源渲染成裸域名角标而非链接，所以 citations 里 url 为 null、只有 host。
    // 交出空数组会让下游以为「平台没给来源」，而实际有 19 个。
    citations: settled.citations,
    citationState: settled.expectedCitationCount ? "self-reported-count" : "dom-only",
    expectedCitationCount: settled.expectedCitationCount ?? null,
    citationDiagnostics: settled.diagnostics,
    submissionMethod: "keyboard-enter",
    // 智谱没有可回查的会话 id（URL 不含 conversation），如实记录而不是编一个。
    conversationId: null,
    currentUrl: page.url(),
    loginState: "anonymous",
    modelVersion: null,
  };
}

/**
 * 等回答成形。
 *
 * 完成判据是**两个条件同时成立**：正文长度连续若干轮不再增长，且页面上
 * 出现「思考结束」。只用其中一个都会出错 ——
 * 只看长度会在深检索的长停顿处截断（千问实测过 104 字停 56 秒），
 * 只看文案则在文案不出现的构建上永远等不到。
 */
async function waitForAnswer(page, { timeoutMs, pollMs }) {
  const deadline = Date.now() + timeoutMs;
  let lastLength = -1;
  let stableRounds = 0;
  const requiredStableRounds = 2;
  let best = null;
  let waitedMs = 0;

  while (Date.now() < deadline) {
    await page.waitForTimeout(pollMs);
    waitedMs = Date.now() - (deadline - timeoutMs);

    const snapshot = await readAnswer(page);
    if (snapshot.answer && (!best || snapshot.answer.length > best.answer.length)) {
      best = snapshot;
    }
    // 比较长度，不是字符串本身：早期版本写的是 `snapshot.answer === lastLength`，
    // 拿字符串和数字比 —— 恒为 false，于是完成判据永远不触发，每次都耗满整个
    // timeoutMs 预算，最后返回「最长的文本块」。而那恰恰是思考过程而不是答案：
    // 实测过一条 188 字符的英文思考记录被当成答案收下，而真正的中文回答只有 54 字。
    // 这类错误不会报错，只会让采集「成功」地记录下错误内容。
    const length = snapshot.answer.length;
    if (length > 0 && length === lastLength) {
      stableRounds += 1;
      // 「思考结束」是实测到的完成信号，但不是唯一出口：某些构建不渲染它。
      // 纯靠它会把已经稳定 5 轮的答案拖到预算耗尽（实测 231s vs 13s）。
      // 所以长度稳定够多轮就放行，文案只作为**提前**结束的条件。
      if (stableRounds >= requiredStableRounds) {
        return { ...snapshot, waitedMs };
      }
    } else {
      stableRounds = 0;
      lastLength = length;
    }
  }
  // 预算耗尽。**不能**直接把最长的文本块当成答案交出去：那是思考过程。
  // 判据是排除而不是确认 —— 出现思考标记的一律不收，因为它长得更长，
  // 而「收下一段思考」在报告里看起来和正常答案没有区别。
  if (best && !/^\s*(思考中|思考过程|Let me think|Thinking)/i.test(best.answer)) {
    return { ...best, waitedMs, lastLength, timedOut: true };
  }
  // 一个字符都没有，或者读到的全是思考：交回失败，由调用方判 ANSWER_NOT_FOUND。
  // 空答案与「答案是空的」必须区分：前者是采集失败，后者是平台的回答。
  return { answer: "", citations: [], diagnostics: ["zhipu-answer-not-located"], waitedMs, lastLength };
}

/**
 * 读答案。
 *
 * 两个实测决定了这个函数的形状：
 *
 * 1. **必须拼接，不能取最长的一段。** 智谱把答案渲染成多个 `<p>`（每段一个），
 *    带检索的回答实测 2409 字符、分成十几段。早期版本「取最长的那个 `<p>`」
 *    只读到 181 字符 —— 表格和后面的来源全丢了，而它看起来仍是一条完整答案。
 *    这是 `MULTI_PLATFORM_LESSONS.md` §3「先修读整段，再谈何时算完」那条教训。
 *
 * 2. **必须排除页脚。** `policy-wrap` 实测 101 字符，在短回答场景下比答案还长。
 *    两者都要处理，所以按「问题气泡之后的整段容器」取全文，再排除噪声节点。
 */
async function readAnswer(page) {
  return page
    .evaluate(
      ({ noise, userBubble }) => {
        const vis = (el) => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
        };
        const text = (el) => (el.innerText || "").trim();

        const bodyText = document.body.innerText || "";
        const bubbles = [...document.querySelectorAll(userBubble)];
        if (!bubbles.length) {
          return {
            answer: "",
            citations: [],
            diagnostics: ["zhipu-answer-not-located"],
            thinkingDone: /思考结束/.test(bodyText),
          };
        }

        // 从最后一个问题气泡往上找到「这一轮对话」的容器，再取它的全文。
        // 逐级上溯而不是固定层数：不同回答长度下对话容器的嵌套深度不同。
        let scope = bubbles[bubbles.length - 1];
        for (let i = 0; i < 6 && scope.parentElement; i += 1) {
          const parent = scope.parentElement;
          const parentText = (parent.innerText || "").trim();
          // 上溯到不再包含更多问题气泡的那一层，就是本轮对话的边界。
          if (parent.querySelectorAll(userBubble).length > bubbles.length) break;
          scope = parent;
          if (parentText.length > 40 && parentText.length < 200_000) {
            // 已经包含完整答案就不再上溯，避免把整个页面（含历史对话）吞进来。
            if (parentText.length > text(scope).length + 40) break;
          }
        }

        // 逐个克隆并剔除噪声与用户气泡，然后取剩余内容的全文。
        // 用 innerText 而不是拼接子节点：表格在 innerText 里会带上制表符，
        // 手工拼接会丢掉表格结构。
        const clone = scope.cloneNode(true);
        clone.querySelectorAll(noise).forEach((el) => el.remove());
        clone.querySelectorAll(userBubble).forEach((el) => el.remove());
        clone.querySelectorAll(".question-txt, [class*='question-txt']").forEach((el) => el.remove());
        // 思考过程节点：它比答案长，不剔除就会被当成答案。
        clone.querySelectorAll("[class*='think'], [class*='Think'], [class*='reason']").forEach((el) => el.remove());

        let answer = (clone.innerText || "").trim();

        // ⚠️ 噪声只从**行首**剥掉，绝不全局替换。
        //
        // 早期版本用 `/ChatGLM/g` 这类全局正则，结果把答案正文里的同名内容一起删掉 ——
        // 问「智谱清言由哪家公司开发」这类问题，答案里本来就会出现产品名。
        // 另一版按整行匹配，又因为智谱把控件和正文渲染在同一行而整行被删，
        // 最终 run 状态是 success、答案只剩 2 个字符（「语音」）。
        // 两次都是在报告里完全看不出来的静默数据损坏。
        //
        // 现在只处理「一行开头连续出现的控件标签」，正文区域一律不动。
        answer = answer
          .split("\n")
          .map((line) => {
            let text = line.replace(/[ \t　]+/g, " ").trim();
            // 行首的控件/身份标签，最多剥 8 轮直到不再匹配。
            for (let i = 0; i < 8; i += 1) {
              const before = text;
              text = text.replace(
                /^(访客_[A-Za-z0-9]+|复制入框|ChatGLM|梦幻杰|语音|NaN|思考中|思考结束|停止生成|重新生成)\s*/,
                "",
              );
              if (text === before) break;
            }
            return text.trim();
          })
          .filter((line) => line.length > 0)
          // 平台免责声明不是答案内容，但它是独立成行的，可以整行去掉。
          .filter((line) => !/^以上内容为\s*AI\s*生成/.test(line))
          .filter((line) => !/^内容由AI生成/.test(line))
          .join("\n")
          .trim();

        // 引用：智谱把来源渲染成**裸域名角标**（askci.com / lbkrs.com / biggo.com.tw），
        // 不是 <a> 标签 —— 实测 querySelectorAll("a[href^='http']") 恒为 0。
        //
        // url 字段必须非空：db/persist.js 的 prepareCitations 会把缺 url 的引用
        // 整个 skip 掉（reason=missing-url），于是「采到了域名却一条没落库」。
        // 所以这里用域名根 URL（https://<host>/）占位，并在 capturedFrom 上标注
        // 「角标」—— 让下游知道这是从角标文本还原的域名，不是平台给出的可点击链接。
        // 伪造一个带路径的 URL 更糟：那会被当成可回查的证据，而它根本不存在。
        const domHosts = [...answer.matchAll(/\b([a-z0-9][a-z0-9-]{1,40}\.(?:com|cn|net|org|tw|io|gov|edu|co|me|info))\b/gi)]
          .map((m) => m[1].toLowerCase())
          .filter((host) => !/chatglm|zhipu|z\.ai|bigmodel/i.test(host));
        const uniqueHosts = [...new Set(domHosts)];
        const selfReported = answer.match(/(\d+)\s*个来源/);
        const citations = uniqueHosts.map((host) => ({
          url: `https://${host}/`,
          title: null,
          domain: host,
          sourceType: "visible",
          capturedFrom: "角标域名",
          citationMarker: null,
        }));

        return {
          answer,
          citations,
          // 平台自陈的来源数（实测「19个来源」）。与抓到的域名数一起交出去：
          // 两者不等说明有来源没被解析出来，报告侧据此标 partial 而不是
          // 悄悄按抓到的数量出数。
          expectedCitationCount: selfReported ? Number(selfReported[1]) : null,
          diagnostics: answer
            ? uniqueHosts.length === 0
              ? ["zhipu-no-visible-sources"]
              : []
            : ["zhipu-answer-not-located"],
          thinkingDone: /思考结束/.test(bodyText),
        };
      },
      { noise: SELECTORS.answerNoise, userBubble: SELECTORS.userBubble },
    )
    .catch(() => ({ answer: "", citations: [], diagnostics: ["zhipu-scan-failed"], thinkingDone: false }));
}

async function loginWallVisible(page) {
  return page
    .evaluate(() => {
      const text = document.body.innerText || "";
      // 未实测到智谱的墙文案，这里只识别明确的登录墙形态，不猜额度文案。
      return /登录后?(继续|才能|解锁)|请先登录|扫码登录/.test(text);
    })
    .catch(() => false);
}

/**
 * 回答是否已可判定完整。
 *
 * 单独暴露是为了让 profile 与 driver 共享同一口径：profile 声明
 * `inProgressPatterns`，driver 用它判断"还在生成"。
 */
export function looksSettled(snapshot) {
  return Boolean(snapshot?.answer) && snapshot?.thinkingDone === true;
}
