import { DoubaoMvpError, ErrorCode } from "./errors.js";
import {
  citationDiagnostics,
  cleanAnswerText,
  parseReferenceItems,
  parseSelfReportedSourceCount,
} from "./wenxin-citations.js";

/**
 * 文心一言（百度，入口 wenxin.baidu.com）匿名面 driver。
 *
 * 全部行为来自 2026-09-28 在本地 Camoufox 出货引擎上的 14 轮探针，记录见
 * `docs/WENXIN_PHASE0.md`。**没有一项是从豆包/千问/智谱类比来的** ——
 * 那是 `docs/MULTI_PLATFORM_LESSONS.md` §1/§2 记着的两次翻车原因。
 *
 * 与其它三个平台的四类真实差异（不是偷懒，是平台事实不同）：
 *
 *  1. **答案与思考块共用 `ai-entry-block` 类名。** 同一轮里
 *     `div.ai-entry-block.ai-thinking-steps` 实测 942 字符，
 *     `div.ai-entry-block.ai-markdown` 只有 155 字符 —— 思考块是答案的 6 倍。
 *     按"最长文本块"取答案会**稳定地**采到搜索步骤，status=success 而内容全错。
 *     所以 `answerSelectors` 必须带 `ai-markdown` 这一位，光写 `ai-entry-block` 就是错的。
 *
 *  2. **风控墙是导航而不是原地替换。** 智谱把「访问验证」渲染在原地（textarea 尺寸 0x0），
 *     文心是**直接跳走**到 `wappass.baidu.com/static/captcha/tuxing_v2.html`，
 *     textarea 从 DOM 里彻底消失。因此墙的判据必须是「当前 URL/正文」，元素存在性判据全部失效；
 *     而页面在等待期间被导航会让 `page.evaluate` 抛「Execution context was destroyed」，
 *     那个异常必须当成数据处理，不能让整轮采集崩掉（实测踩到过，探测脚本直接挂了）。
 *
 *  3. **引用 URL 在 data 属性里，DOM 里没有链接。** `li[class*='reference-item']`
 *     不含任何 `<a>`、没有 href 属性（实测 22-30 条，`querySelectorAll("a[href^=http]")` 为 0），
 *     真实地址在 `data-long-press-ext-info='{"link":"https://...","linkTitle":"..."}'`。
 *     只找 `<a>` 会得到「平台自陈 23 篇资料、一条都没采到」。
 *
 *  4. **重置必须点按钮，不能重新加载。** 实测重新 goto 入口页会撞上百度安全验证墙；
 *     而点 `div.new-dialog-container-button` 并**验证 `.ai-entry-block` 计数归零**后
 *     连续两问正常（133→225 字符）。
 */

const SELECTORS = {
  // 实测：唯一可编辑元素是 textarea#chat-textarea，类名 ci-textarea ci-scroll-style。
  // placeholder 是**轮换的热点话题**（实测「肖战第1次上热搜涨粉130万」「帮我写国旗下讲话发言稿」
  // 「智界 RX及鸿蒙智行新品发布会」），每次刷新都不同 —— 绝不能拿它当选择器或身份标识。
  composer: "textarea#chat-textarea",
  // 对话内的提问气泡。实测类名稳定（`cs-question-bubble`）。
  //
  // ⚠️ 页面里**同时**存在历史栏里的同一段文字：`chat-side-list-item` / `history-item-content` /
  // `history-item-text`。历史栏是跨会话累积的，锚到它会读到上一轮的提问（见下方
  // startFreshConversation 的注释与 MULTI_PLATFORM_LESSONS.md §3）。
  userBubble: ".cs-question-bubble",
  // 答案块。`ai-markdown` 是必须的排他位，见文件头第 1 条实测差异。
  answer: ".ai-entry-block.ai-markdown",
  // 思考/检索步骤块：与答案块共用 ai-entry-block，必须显式排除。
  thinking: ".ai-entry-block.ai-thinking-steps",
  // 引导弹层：满屏 1280x720，`cos-dialog-mask` 是它的遮罩。实测冷启动会注入并拦截指针。
  guideDialog: "div.cos-dialog",
  guideDialogMask: "div.cos-dialog-mask",
  // 关闭控件**没有文字也没有 aria-label**（实测 closers: div.cos-dialog-close / i.cos-icon-close），
  // 按可见文字找必然失配 —— 与智谱的 button.close-btn 同一类坑。
  dialogClose: "div.cos-dialog-close, i.cos-icon-close",
  // 「开启新对话」的真实按钮。历史栏里也有个「新对话」文字节点，按文字找会点到它。
  newConversationButton: "div.new-dialog-container-button",
  referenceItem: "li[class*='reference-item']",
  // 追问气泡：平台在**认为这一轮结束时**才渲染它们。实测（探针 15）：
  // 提问后 29.1 秒内恒为 0，t=29.6s 与答案冻结同帧出现，之后恒定。
  // 这是本平台唯一可靠的完成信号 —— 文心不用「生成中/停止生成」文案表示忙。
  followUpChips: "[class*='cs-question-closely']",
};

/** 平台侧墙与登录面的文案，实测逐字（docs/WENXIN_PHASE0.md）。 */
const WALL_TEXT = {
  verification: "百度安全验证",
  verificationDetail: "请完成下方验证后继续操作",
  slider: "拖动左侧滑块使图片为正",
  // 登录墙未观测到：匿名面 14 轮从未要求登录，页面上常驻的是「请登录」入口，
  // 那不是墙。所以 login_wall 的判据只在**正文出现强制措辞**时才成立。
  loginForce: "登录后才能继续",
};

/** 打开页面并让输入框处于可提交状态。 */
export async function openWenxin(page, config, profile) {
  await page
    .goto(profile.entryUrl, { waitUntil: "domcontentloaded", timeout: config.timeoutMs ?? 60_000 })
    .catch(() => undefined);
  await page.waitForTimeout(3_000);

  // ⚠️ 先判墙，再清弹层。
  //
  // 文心的墙是**导航**：页面会跳到 wappass.baidu.com 的滑块验证，那里的 DOM 里
  // 根本没有 textarea。任何以输入框为准的判断都会得到「输入框不存在」，
  // 而那和「弹层挡住了」需要完全相反的处置 —— 弹层清掉还能继续，墙只能退避等平台放行。
  const gate = await pageGate(page);
  if (gate.blocked) {
    throw new DoubaoMvpError(gateErrorCode(gate.kind), gate.message, {
      stage: "open",
      url: page.url(),
      gate: gate.kind,
      ...gate.details,
    });
  }

  await dismissOverlays(page);

  // 判据是 DOM 事实（见 MULTI_PLATFORM_LESSONS.md §9.2）：存在 + 非零尺寸 + 中心点命中自身。
  // 不用 Playwright 的 click({trial:true})，它在 Camoufox 上会给出与 DOM 事实相反的结论。
  const composer = page.locator(SELECTORS.composer).first();
  if (!(await waitForUsableComposer(page, composer))) {
    // 清弹层花了几十秒，墙可能在这期间才落下，所以再判一次。
    const late = await pageGate(page);
    if (late.blocked) {
      throw new DoubaoMvpError(gateErrorCode(late.kind), late.message, {
        stage: "open",
        url: page.url(),
        gate: late.kind,
        ...late.details,
      });
    }
    throw new DoubaoMvpError(
      ErrorCode.PAGE_CHANGED,
      "文心一言输入框不可提交（引导弹层未关闭或页面结构变化），匿名采集无法开始。",
      { stage: "open", url: page.url(), overlays: await overlayCount(page) },
    );
  }
  return page;
}

function gateErrorCode(kind) {
  if (kind === "login_wall") return ErrorCode.LOGIN_REQUIRED;
  if (kind === "verification") return ErrorCode.VERIFICATION_REQUIRED;
  return ErrorCode.ACCESS_RESTRICTED;
}

/**
 * 判断页面当前被什么挡住。
 *
 * 判据是**URL + 正文文案**，不是元素存在性：文心的验证页在另一个域名下，
 * 那里没有 textarea，用存在性判会把「被风控挡了」读成「输入框还没渲染」。
 */
async function pageGate(page) {
  const state = await safeEvaluate(page, () => {
    const body = document.body?.innerText || "";
    const ta = document.querySelector("textarea");
    const r = ta ? ta.getBoundingClientRect() : null;
    const m = body.match(/[^\n]{0,30}(百度安全验证|请完成下方验证|拖动左侧滑块)[^\n]{0,30}/);
    return {
      host: location.hostname,
      url: location.href,
      hasComposer: Boolean(ta),
      composerW: r ? Math.round(r.width) : 0,
      composerH: r ? Math.round(r.height) : 0,
      verification: /百度安全验证|请完成下方验证|拖动左侧滑块|请进行验证/.test(body)
        || /wappass\.baidu\.com/.test(location.hostname),
      verificationText: m ? m[0].trim() : "",
      loginWall: /登录后才能继续|请先登录后使用|登录解锁完整功能/.test(body),
    };
  });
  if (!state || state.__navigated) return { blocked: false, kind: "clear" };

  if (state.verification) {
    return {
      blocked: true,
      kind: "verification",
      message:
        `文心一言跳转到百度安全验证页（${state.verificationText || WALL_TEXT.verification}），`
        + "本次出口已被平台风控；应退避等待其自行放行，不要立即重试",
      details: { host: state.host, composerW: state.composerW, composerH: state.composerH },
    };
  }
  if (!state.hasComposer) {
    return {
      blocked: true,
      kind: "verification",
      message: "文心一言页面上输入框不存在（已离开正常会话页），应退避等待而不是反复重开",
      details: { host: state.host, url: state.url },
    };
  }
  if (state.composerW === 0 && state.composerH === 0) {
    return {
      blocked: true,
      kind: "verification",
      message: "文心一言输入框被压成 0x0，页面处于风控状态；应退避等待，不要立即重试",
      details: { loginWall: state.loginWall },
    };
  }
  if (state.loginWall) {
    return {
      blocked: true,
      kind: "login_wall",
      message: "文心一言匿名面已被登录墙取代（需要登录才能继续），本次采集无法开始",
      details: {},
    };
  }
  return { blocked: false, kind: "clear" };
}

/**
 * `page.evaluate` 在页面被导航时会抛「Execution context was destroyed」。
 *
 * 实测这不是理论风险：文心的风控墙就是靠导航实现的，等待答案期间撞上它会让整段
 * evaluate 抛异常。探测脚本里就因此直接崩掉过一次（整轮数据丢失）。
 *
 * 所以：**导航是数据，不是异常。** 这里统一把它转成 `{__navigated: true}`，
 * 让调用方当作"页面状态变了"处理，而不是让异常冒泡把整轮采集带走。
 */
async function safeEvaluate(page, fn, arg) {
  try {
    return await page.evaluate(fn, arg);
  } catch (error) {
    const text = String(error?.message ?? error);
    if (/context was destroyed|Target (page|closed)|Execution context/i.test(text)) {
      return { __navigated: true };
    }
    throw error;
  }
}

/** 等输入框真正可提交：存在 + 非零尺寸 + 中心点命中自身。 */
async function waitForUsableComposer(page, composer, { timeoutMs = 20_000, stepMs = 1_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let last = null;
  while (Date.now() < deadline) {
    attempts += 1;
    last = await composerUsability(page);
    if (last.usable) return true;
    // 弹层可能是上一次检查之后才注入的（文心是延迟注入），所以每轮都再清一次。
    await dismissOverlays(page);
    await page.waitForTimeout(stepMs);
  }
  console.warn(
    `[wenxin] 输入框在 ${timeoutMs}ms 内始终不可提交（清弹层 ${attempts} 轮）：`
    + `exists=${last?.exists} size=${last?.w}x${last?.h} hit=${last?.hitSelf}`,
  );
  return false;
}

async function composerUsability(page) {
  const state = await safeEvaluate(page, () => {
    const ta = document.querySelector("textarea#chat-textarea") || document.querySelector("textarea");
    if (!ta) return { exists: false, w: 0, h: 0, hitSelf: false, usable: false };
    const r = ta.getBoundingClientRect();
    const w = Math.round(r.width);
    const h = Math.round(r.height);
    if (w === 0 || h === 0) return { exists: true, w, h, hitSelf: false, usable: false };
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    const hitSelf = Boolean(top && (top === ta || ta.contains(top)));
    return { exists: true, w, h, hitSelf, usable: hitSelf };
  });
  if (!state || state.__navigated) return { exists: false, w: 0, h: 0, hitSelf: false, usable: false };
  return state;
}

async function overlayCount(page) {
  const n = await safeEvaluate(page, () =>
    [...document.querySelectorAll("div.cos-dialog, div.cos-dialog-mask, [role='dialog']")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }).length);
  return typeof n === "number" ? n : -1;
}

/**
 * 关掉引导弹层，并且**验证遮罩真的消失**。
 *
 * 实测：文心冷启动会注入 `div.cos-dialog._task-mode-guide-dialog`（满屏 1280x720）
 * 加 `div.cos-dialog-mask`，它拦截 textarea 上的指针事件 —— Playwright 的
 * click 会一直重试到超时并报「subtree intercepts pointer events」。
 *
 * 「点了关闭按钮」不等于「弹层没了」：遮罩有淡出动画，提前返回会让下一步仍然被拦。
 * 所以判据是遮罩计数为 0（叠加最后的输入框命中测试），不是点击成功。
 *
 * 兜底是 Escape —— 真人也会这么做，而文心的关闭控件没有文字也没有 aria-label，
 * 按可见文字找必然失配（与智谱的 button.close-btn 同一类坑，见 MULTI_PLATFORM_LESSONS.md §2）。
 */
async function dismissOverlays(page) {
  // 解析函数**推迟**取 locator，不是在定义时就取：`page.locator()` 会立刻查询，
  // 弹层是延迟注入的，取太早会拿到一个还不存在的东西。
  //
  // ⚠️ 两条都是本轮真踩到的：
  //  1. `page.locator()` 必须是**函数**。写成 `async () => ...` 会返回 Promise<Locator>，
  //     下面拿到的是 Promise，报错 `loc.count is not a function`。
  //  2. `.first` 在 playwright-core 1.63 上是**方法**（`first(): Locator`），不是属性。
  //     写 `.first` 拿到的是 undefined，于是整段被静默降级成"没找到关闭控件"，
  //     走进 Escape 兜底 —— 而文心的弹层并不响应 Escape。
  //     结果：弹层永远关不掉，报错点还落在"输入框不可提交"上，真因被推迟到很难定位的地方。
  const attempts = [
    () => page.locator(SELECTORS.dialogClose).first(),
    // 兜底是 Escape：文心的关闭控件无文字无 aria-label，Escape 是另一条人道路径。
    () => null,
  ];
  for (const resolve of attempts) {
    const loc = resolve();
    if (loc && typeof loc.count === "function") {
      const usable = await loc
        .count()
        .then((n) => n > 0)
        .then((has) => (has ? loc.isVisible({ timeout: 1_000 }).catch(() => false) : false))
        .catch(() => false);
      if (usable) {
        await loc.click({ timeout: 3_000 }).catch(() => undefined);
        // 等淡出走完再判定，否则遮罩还在但已被标记为不可见。
        await page.waitForTimeout(900);
        if ((await overlayCount(page)) === 0) return true;
      }
    } else {
      await page.keyboard.press("Escape").catch(() => undefined);
      await page.waitForTimeout(700);
      if ((await overlayCount(page)) === 0) return true;
    }
  }
  return (await overlayCount(page)) === 0;
}

/**
 * 切到一段干净的新对话。
 *
 * 判据是**回答块计数归零**，不是「点了新对话」：
 *
 *  - 历史栏里也有「新对话」文字节点，按文字找会点到它，点完上下文没清；
 *  - 点击不保证立刻清空（实测要等几百毫秒到 2 秒）；
 *  - 更要命的是：**清空失败时不会报错**。探针里没点重置连问四题，稳定性判据在 3.1 秒
 *    就把**上一题的答案**（249 字符 / 25 引用，逐字相同）当成了这一题的回答，
 *    status 看起来是成功的。这与 MULTI_PLATFORM_LESSONS.md §3 记的千问/智谱截断
 *    是同一族危害：产出看起来正常、内容全错。
 *
 * 所以这里在提问前就要求重置被确认，否则抛 CONVERSATION_RESET_FAILED 而不是带着
 * 旧上下文提问 —— 宁可这一轮失败，也不要记下一条错配的答案。
 *
 * 另：实测**重新 goto 入口页不可用作重置**，它会撞上百度安全验证墙。
 */
async function startFreshConversation(page, { attempts = 3 } = {}) {
  // ⚠️ 必须是**函数**形式，不是字符串。
  //
  // page.evaluate 收到字符串时把它当**表达式**求值，所以 `"() => ...length"`
  // 求出来是一个函数对象，而不是那个数字。实测踩过：`blocks()` 于是返回
  // `Function` 而不是 `0`，`=== 0` 恒为 false，于是永远去点「新对话」按钮；
  // 而这一轮本来就没有历史轮，点了也没用，12 次轮询后判定"重置失败"。
  // 症状是 CONVERSATION_RESET_FAILED，真因却在两行之外 —— 正是
  // MULTI_PLATFORM_LESSONS.md §13「报错点与真因不在一处」那条。
  const blocks = () => safeEvaluate(page, () => document.querySelectorAll(".ai-entry-block").length);

  // 平台不显示"生成中"文案，而**这里不判"仍在生成"**。
  //
  // 早先查过 `[class*='loading']` 之类，然后踩了自己的坑：文心答案块外面长期挂着
  // 一个「思考中折叠面板 + 工具图标条」，而那个图标条里**本来就有一个**类名匹配
  // `[class*='loading']` 的元素。于是每轮都被判成"还在生成"，白等 60 秒，
  // 真因（会话重置判据）被彻底盖住，报错指向了一个并不存在的"平台还在忙"。
  //
  // 这正是 MULTI_PLATFORM_LESSONS.md §3 那条：**平台没给出这个信号时，
  // 自己造一个启发式出来比没有更糟** —— 假阳性会让每一轮都走慢路径，
  // 而真因被埋在那条慢路径底下。长度稳定判据已在 waitForAnswer 里给出唯一出口。
  //
  // 仍然保留的等待只有一条：平台自己说"请等待"的文案。实测文心没有这句，
  // 所以这里同样不写 —— 写一个没见过的等待条件，等于多一条会静默生效的慢路径。
  if ((await blocks()) === 0) return { ok: true, attempts: 0, verified: true };

  // 每一轮尝试都记下现场：按钮在不在、可见不可见、点了没有、点击时有没有被遮挡。
  // 「重置失败」本身不说明原因 —— 不记现场就只能猜，而猜出来的报错会把人引到错的地方。
  const trace = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const before = await blocks();
    const candidates = [
      SELECTORS.newConversationButton,
      // 探针实测这一档也有效：按钮容器本身。文字节点在历史栏里也有，按文字找会点到它。
      "div.new-dialog-container",
      // 最后一档：按钮上的可见文字「开启新对话」。实测冷启动渲染的是这一句，
      // 而「新对话」三个字在历史栏里也有同名的 —— 所以放在最后。
      "text=开启新对话",
    ];
    for (const selector of candidates) {
      const target = page.locator(selector).first();
      const counted = await target.count().catch(() => 0);
      if (!counted) {
        trace.push({ attempt, selector, counted: 0 });
        continue;
      }
      const visible = await target.isVisible({ timeout: 1_500 }).catch(() => false);
      if (!visible) {
        trace.push({ attempt, selector, counted, visible: false });
        continue;
      }
      // 点击失败不吞掉：Playwright 的错误文本（"subtree intercepts pointer events" 之类）
      // 正是「弹层又冒出来了」的直接证据。
      const clicked = await target.click({ timeout: 3_000 })
        .then(() => "ok")
        .catch((error) => String(error?.message ?? error).split("\n")[0].slice(0, 120));
      trace.push({ attempt, selector, counted, visible: true, clicked, blocksBefore: before });
      if (clicked !== "ok") continue;
      for (let i = 0; i < 12; i += 1) {
        await page.waitForTimeout(400);
        if ((await blocks()) === 0) {
          return { ok: true, attempts: attempt, verified: true, trace };
        }
      }
    }
  }
  return { ok: false, attempts, verified: false, blocksLeft: await blocks(), trace };
}

/** 提交一条提问并等待回答成形。 */
export async function executeWenxinPrompt(page, prompt, config, profile) {
  const timeoutMs = config.timeoutMs ?? 180_000;
  const pollMs = config.pollMs ?? 1_000;

  // ⚠️ 必须在提问**之前**确认重置。profile 声明 promptsPerWindow: 1，
  // 那个声明只有 driver 真的清掉上下文才成立；不成立时后果不是报错而是**采到上一题的答案**。
  const reset = await startFreshConversation(page);
  if (!reset.ok) {
    throw new DoubaoMvpError(
      ErrorCode.CONVERSATION_RESET_FAILED,
      "文心一言未能切换到新对话，提问会落进上一段上下文并读回错误答案。",
      {
        stage: "conversation",
        url: page.url(),
        attempts: reset.attempts,
        blocksLeft: reset.blocksLeft,
        // 把现场带上：按钮在不在、可见不可见、点击是否被遮挡、点击后还剩几个块。
        // 只报"重置失败"的话，排查只能靠猜 —— 而猜出来的原因几乎总是错的。
        resetTrace: reset.trace,
      },
    );
  }

  // 弹层可能在等待期间再次注入（文心是延迟注入），提交前再清一次并复判输入框。
  await dismissOverlays(page);
  const composer = page.locator(SELECTORS.composer).first();
  if (!(await composerUsability(page)).usable) {
    const gate = await pageGate(page);
    if (gate.blocked) {
      throw new DoubaoMvpError(gateErrorCode(gate.kind), gate.message, {
        stage: "submit", url: page.url(), gate: gate.kind, ...gate.details,
      });
    }
    throw new DoubaoMvpError(
      ErrorCode.PAGE_CHANGED,
      "文心一言输入框在提交前不可用（弹层遮挡或页面结构变化），本次未提交。",
      { stage: "submit", url: page.url(), overlays: await overlayCount(page) },
    );
  }

  // 聚焦用 DOM focus()：Playwright 的 click 带指针命中判定，在 Camoufox 上会误判不可点。
  await composer.evaluate((el) => el.focus());
  await composer.type(prompt, { delay: 40 });

  // 发送控件不可发现（实测页面上没有可提出来的发送按钮，探测脚本的 send btns 为空数组），
  // 键盘 Enter 是实测唯一测通的提交路径。
  const before = page.url();
  await composer.press("Enter");

  const settled = await waitForAnswer(page, { timeoutMs, pollMs });

  // 墙可能在等待期间才落下（文心的墙是导航，所以这里必须重新判一次 URL）。
  if (settled.navigatedToWall) {
    throw new DoubaoMvpError(
      ErrorCode.VERIFICATION_REQUIRED,
      "文心一言提交后跳转到百度安全验证页，本次出口已被风控；应退避等待，不要立即重试。",
      { stage: "answer", before, wall: settled.wallText, url: page.url() },
    );
  }

  if (!settled.answer) {
    const wall = await pageGate(page);
    if (wall.blocked) {
      throw new DoubaoMvpError(gateErrorCode(wall.kind), wall.message, {
        stage: "answer", url: page.url(), gate: wall.kind, ...wall.details,
      });
    }
    throw new DoubaoMvpError(
      ErrorCode.ANSWER_NOT_FOUND,
      "文心一言提交后未读到回答正文。",
      {
        stage: "answer",
        url: page.url(),
        before,
        waitedMs: settled.waitedMs,
        lastLength: settled.lastLength,
        navigations: settled.navigations,
      },
    );
  }

  return {
    answer: settled.answer,
    citations: settled.citations,
    citationState: settled.expectedCitationCount ? "self-reported-count" : "dom-only",
    expectedCitationCount: settled.expectedCitationCount ?? null,
    citationDiagnostics: settled.diagnostics,
    // 回答是怎么判定完成的。三种取值各有含义，下游必须能区分：
    //   follow-up-chips            平台明确收尾了（追问气泡出现）—— 可信
    //   length-stability-fallback  气泡没出现、靠长度稳定猜的 —— 可能被截断
    //   timeout                    耗尽预算才返回的 —— 大概率不完整
    // 实测文心的默认路径是第一种；后两种存在就是为了"平台改版时不至于全线失败"，
    // 而不是宣称它们同样可靠。
    answerCompletion: settled.completedBy ?? "unknown",
    submissionMethod: "keyboard-enter",
    // 实测 14 轮 URL 始终停在 wenxin.baidu.com 根路径，会话状态只在页面内（不进路径），
    // 所以没有可回查的 conversationId —— 如实记 null，编一个比留空更糟。
    conversationId: null,
    currentUrl: page.url(),
    loginState: "anonymous",
    modelVersion: null,
  };
}

/**
 * 等回答成形。
 *
 * 完成判据是**答案块长度连续若干轮不再增长**。文心**没有任何在生成信号**：
 * 14 轮实测 stopish（停止/暂停控件）恒为 0 轮出现，body 里也从不出现「生成中/停止生成」。
 * 这与千问相反（千问靠发送控件消失）也与智谱相反（智谱靠「思考结束」文案）。
 * 所以长度稳定是**唯一**可用的出口，必须留够轮数覆盖平台的长停顿。
 *
 * 另外两条硬事实决定了这个循环的写法：
 *  1. 判长度必须用 `.length` 且与上一次的**长度**比较。早期 zhipu 版本写成
 *     `snapshot.answer === lastLength`（字符串比数字，恒 false），导致完成判据永不触发，
 *     每次都耗满预算并把思考过程当成答案收下。
 *  2. 等待期间页面可能被导航到验证页（实测），所以每次 evaluate 都要能扛住
 *     「Execution context was destroyed」，并且**把导航本身当成一种结束信号**去识别，
 *     而不是让它变成异常。
 */
async function waitForAnswer(page, { timeoutMs, pollMs }) {
  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  let lastLength = -1;
  let stableRounds = 0;
  // 气泡路径：气泡出现时往往已经稳定了 2 轮，再确认 3 轮就够（DOM 顺序不保证同帧）。
  const requiredStableRounds = 3;
  // 兜底路径：10 轮 × 1s = 10 秒，覆盖实测最长的 2.6 秒气泡后冻结 + 足够余量，
  // 又远高于重写间隙的 1-2 秒。低于 10 就会收下重写中间态（实测收下 41 字符）。
  const fallbackStableRounds = Math.max(
    requiredStableRounds + 1,
    Math.ceil(10_000 / Math.max(200, pollMs)),
  );
  let best = null;
  let navigations = 0;
  let lastBody = "";

  while (Date.now() < deadline) {
    await page.waitForTimeout(pollMs);
    const waitedMs = Date.now() - startedAt;

    // 导航优先判定：一旦跳到验证页，页面上的答案块已经不是我们要的东西了。
    const nav = await safeEvaluate(page, () => ({ host: location.hostname, url: location.href,
      body: (document.body?.innerText || "").slice(0, 400) }));
    if (nav && nav.__navigated) {
      navigations += 1;
      // 导航后上下文已废，重新等一小段让新页面渲染，再判墙。
      await page.waitForTimeout(1_500);
      const gate = await pageGate(page);
      if (gate.blocked) {
        return { answer: "", citations: [], diagnostics: ["wenxin-verification-wall"],
                 waitedMs, lastLength, navigations, navigatedToWall: true, wallText: gate.message };
      }
      lastLength = -1;
      stableRounds = 0;
      continue;
    }
    if (nav && /wappass\.baidu\.com/.test(nav.host || "")) {
      return { answer: "", citations: [], diagnostics: ["wenxin-verification-wall"],
               waitedMs, lastLength, navigations, navigatedToWall: true,
               wallText: nav.body?.slice(0, 120) || WALL_TEXT.verification };
    }
    lastBody = nav?.body ?? "";

    const snapshot = await readAnswer(page);
    if (snapshot.answer && (!best || snapshot.answer.length > best.answer.length)) {
      best = snapshot;
    }
    const length = snapshot.answer.length;

    // ⚠️ 完成判据是**追问气泡出现**，不是长度稳定。
    //
    // 实测（探针 15，2026-09-28）：文心的答案块**不是流式增长的**，而是**反复整块重写** ——
    // 同一次提问里长度序列是 116 → 40 → 9 → 115 → 134 → 36 → 19 → 41。
    // 任何"长度不再增长就收"的判据都会在重写间隙收下一个**半成品**，
    // 而且它读起来是通顺的：实测被误收的是 41 字符的收尾追问句
    // 「需要我为你规划一条西湖区一日游经典路线吗？」—— 报告里完全看不出被截断。
    // 这就是 MULTI_PLATFORM_LESSONS.md §3 那一族（千问 104 字停 56 秒），但更隐蔽：
    // 平台根本不是"停顿"，是"重写"。
    //
    // 真正的完成信号是**追问气泡**（`cs-question-closely-*`）：实测它在 t=29.6s 出现，
    // 与答案冻结是同一时刻（之前 29.1 秒里恒为 0，之后 26.8 秒恒为 199）。
    // 平台只有在认为这一轮结束时才渲染它。
    //
    // 早先一直找不到它，是因为一直在找「生成中 / 停止生成」这类文案 —— 而文心
    // 根本不用文案表示"还在生成"（14 轮实测 stopish 恒为 0）。
    // 结论：**信号未必是文案，找到什么就用什么**；但出现后仍要求长度稳定 N 轮，
    // 因为气泡与答案冻结是同帧发生的，DOM 顺序不保证。
    if (snapshot.followUpVisible && length > 0) {
      if (length === lastLength) {
        stableRounds += 1;
        if (stableRounds >= requiredStableRounds) {
          return { ...snapshot, waitedMs, lastLength, navigations,
                   completedBy: "follow-up-chips" };
        }
      } else {
        stableRounds = 0;
      }
      lastLength = length;
      continue;
    }

    // 没有气泡时的兜底：长度稳定够多轮再收。
    //
    // 门槛必须**远高于**真实完成所需。实测气泡出现时往往已经有 2 轮稳定，
    // 而重写间隙的稳定可以持续 1-2 轮（pollMs=1s 时），所以 3 轮是危险的 ——
    // 实测 driver 用 3 轮时正好收下 41 字符的重写中间态。10 轮（10 秒）把两个
    // 分布分开了：实测最长的一次完整回答在气泡出现后 2.6 秒才停。
    //
    // 但兜底本身是**不可信的**：它收下的东西可能仍然是重写中间态。
    // 所以落库时打上 completedBy 标记，让下游能区分"平台明确收尾"和"靠稳定猜的"。
    if (length > 0 && length === lastLength) {
      stableRounds += 1;
      if (stableRounds >= fallbackStableRounds) {
        return { ...snapshot, waitedMs, lastLength, navigations,
                 completedBy: "length-stability-fallback" };
      }
    } else {
      stableRounds = 0;
      lastLength = length;
    }
  }

  // 预算耗尽。没有"生成中"信号可等时，最长的那份就是最接近完整的答案；
  // 但**必须**排除思考块（它是同一个 ai-entry-block 类名，且长得多）。
  if (best && best.answer) {
    return { ...best, waitedMs, lastLength, navigations, timedOut: true,
             completedBy: "timeout" };
  }
  return {
    answer: "",
    citations: [],
    diagnostics: ["wenxin-answer-not-located"],
    waitedMs,
    lastLength,
    navigations,
    bodyHead: lastBody.slice(0, 200),
  };
}

/**
 * 读答案与引用。
 *
 * 三件实测事实决定了这个函数的形状：
 *
 * 1. **只读 `ai-markdown`，绝不读 `ai-entry-block`。** 两者是同一轮里的兄弟节点，
 *    思考块（搜索步骤 + 关键词列表 + 参考条目）实测 834-942 字符，答案 62-235 字符。
 *    页面结构干净到不需要任何噪声过滤：追问气泡（`cs-question-closely-*`）和
 *    免责声明（`内容由AI生成，仅供参考`）实测都在答案块**外面**（insideAnswer=false）。
 *
 * 2. **引用 URL 从 data 属性里取。** 参考条目 `li[class*='reference-item']` 里
 *    没有任何 `<a>`、没有 href 属性，真实地址在
 *    `data-long-press-ext-info` 的 JSON 里：`{"link":"https://...","linkTitle":"..."}`。
 *    `db/persist.js` 的 prepareCitations 会把缺 url 的引用整条 skip（reason=missing-url），
 *    所以只找 `<a>` 的后果是「平台自陈 23 篇资料、库里一条都没有」。
 *
 * 3. **零宽字符由 Node 侧剥掉。** 见 `src/wenxin-citations.js` 的 INVISIBLE_CHARS。
 *
 * 分工：这里只**取原始材料**，清洗与解析在 `src/wenxin-citations.js` 里做。
 * 原因很直接 —— 跑在 page.evaluate 里的代码没法在 Node 里测，而这一层的错误
 * （采到思考过程、丢掉引用）不报错，只会静默产出错数据。
 */
async function readAnswer(page) {
  // ⚠️ 页面侧闭包**看不到**模块作用域：SELECTORS / cleanAnswerText 这些名字在
  // page.evaluate 里有理都不理（它是序列化后丢进浏览器的函数）。
  // 实测踩过：引用 SELECTORS.followUpChips 直接抛
  // `SELECTORS is not defined`，而报错点在 @debugger eval 里，离真因很远。
  // 所以选择器一律走参数传进去 —— 与 answer / thinking / userBubble 同一个通道。
  const raw = await safeEvaluate(page, ({ answer, thinking, userBubble, referenceItem, followUpChips }) => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };

    // 只取**最后一个**答案块：同一会话里若有历史轮，取第一个会读到上一题。
    const answers = [...document.querySelectorAll(answer)].filter(vis);
    if (!answers.length) {
      return { answerText: "", references: [], bodyText: "" };
    }
    const node = answers[answers.length - 1];

    // 兜底剔除：块内若混进了思考或提问气泡（改版时可能发生），先剔掉再取原文。
    const clone = node.cloneNode(true);
    clone.querySelectorAll(thinking).forEach((el) => el.remove());
    clone.querySelectorAll(userBubble).forEach((el) => el.remove());

    return {
      answerText: clone.innerText || "",
      // 追问气泡：平台只在**认为这一轮结束时**才渲染它们，实测与答案冻结同帧发生。
      // 这是本平台唯一可靠的完成信号（见 waitForAnswer 的注释）。
      followUpVisible: [...document.querySelectorAll(followUpChips)].some((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }),
      // 真实链接只在这个 data 属性里；DOM 上没有 <a>，也没有 href。
      references: [...document.querySelectorAll(referenceItem)].filter(vis).map((li) => ({
        extInfo: li.getAttribute("data-long-press-ext-info"),
        text: (li.innerText || "").trim(),
      })),
      bodyText: document.body?.innerText || "",
    };
  }, {
    answer: SELECTORS.answer,
    thinking: SELECTORS.thinking,
    userBubble: SELECTORS.userBubble,
    referenceItem: SELECTORS.referenceItem,
    followUpChips: SELECTORS.followUpChips,
  });

  if (!raw || raw.__navigated) {
    return { answer: "", citations: [], diagnostics: ["wenxin-scan-navigated"],
             expectedCitationCount: null, followUpVisible: false };
  }

  const body = cleanAnswerText(raw.answerText);
  const citations = parseReferenceItems(raw.references);
  const expectedCitationCount = parseSelfReportedSourceCount(raw.bodyText);
  return {
    answer: body,
    citations,
    expectedCitationCount,
    followUpVisible: Boolean(raw.followUpVisible),
    diagnostics: body
      ? citationDiagnostics({ captured: citations.length, selfReported: expectedCitationCount })
      : ["wenxin-answer-not-located"],
  };
}

/** 回答是否已可判定完整。给 profile 与 driver 共享同一口径用。 */
export function looksSettled(snapshot) {
  return Boolean(snapshot?.answer) && (snapshot?.diagnostics ?? []).length >= 0;
}
