# 智谱清言（chatglm.cn）Phase 0 实测记录

采集日期：2026-09-27 · 引擎：本地 Camoufox（`.venv`，headless，zh-CN）
原始数据：`.onegl/phase0/zhipu-web.anonymous.json`、`.runtime/zhipu-chat-observation.json`

这份记录是 `src/providers/zhipu-web.js` 每个字段的来源。按
`docs/MULTI_PLATFORM_LESSONS.md` 的教训，**没有一项是从豆包或千问类比来的**。

---

## 1. 匿名面成立

| 观察 | 结果 |
|---|---|
| 入口 | `https://chatglm.cn/main/alltoolsdetail?lang=zh`（302 前的落地页，标题「智谱清言」） |
| 登录墙 | `loginWallObserved = false`（两轮均未出现） |
| 身份标记 | 正文出现「访客_5bd9cf」—— 匿名访客身份 |
| 提问 | **成功**，拿到完整回答 |

### 六个 cookie 全是空值

```
chatglm_token = ""
chatglm_token_expires = ""
chatglm_refresh_token = ""
chatglm_user_id = ""
ssxmod_itna = ""
ssxmod_itna2 = ""
```

**这是本次最关键的一条。** 名字里带 `token` / `user_id` 很容易被误当成登录凭据——
豆包的 `passport_csrf_token` 已经制造过一次「未扫码也绑定成功」的事故。
实测值全为空，且页面同时显示登录入口与访客身份，证明这一轮确实未登录。

因此 `login.sessionCookies` 保持空数组是正确的：匿名面没有会话可测。

---

## 2. 三个真实障碍

### 2.1 引导弹层挡住输入框

首次尝试点击 `textarea` 时 Playwright 报：

```
<video class="visual-image"> from <div class="el-overlay dialog-fade-enter-active">
  subtree intercepts pointer events
```

弹层是 Element Plus 的新手引导（`el-dialog.claw-guide-dialog`），其关闭控件
`button.close-btn` **没有 aria-label、没有文字**，只有一个图标。
按可见文字找「关闭 / 我知道了」的兜底链在这里必然失配 —— 这就是
`MULTI_PLATFORM_LESSONS.md` §2 说的「兜底链里只要有一档会假成功，整条链的语义就废了」。

**可用解法**（driver 必须包含）：先按文字找，再按 `button.close-btn` 找，
最后 Escape；**并验证弹层真的消失**再输入，不要假设点击生效了。

### 2.2 输入框没有任何稳定标识

```html
<textarea rows="1" autofocus="" placeholder="" data-v-642ee465="" class="scroll-display-none">
```

- `placeholder` 为空
- 无 `aria-label`、无 `role`、无 `data-testid`
- 唯一类名 `scroll-display-none` 是工具类（隐藏滚动条）
- `data-v-642ee465` 是 Vue scoped 哈希，**每次构建都会变**

`tools/provider-phase0.js` 的启发式提不出选择器是正确的行为，不是缺陷。
`MULTI_PLATFORM_LESSONS.md` §1 记着豆包 `qrcode-DeN5Ny` 换构建就选不中的事故。

**当前取值**：`composerSelectors: ['textarea']` —— 页面实测只有这一个可编辑元素。

### 2.3 答案容器没有类名

实测到的候选块（按长度排序）：

| 长度 | 标签 | class |
|---:|---|---|
| 101 | div | `policy-wrap` ← **页脚**，不是答案 |
| 54 | p | *(无)* ← **这才是答案** |
| 14 | div | `title` |
| 14 | div | `conversation-name el-tooltip__trigger el-tooltip__trigger` |
| 14 | div | `fs14 flex1 ft_grey3 question-txt dots wrap pr dot-5-line` ← **用户气泡** |

**问题侧有稳定类名（`question-txt`），答案侧完全没有。**
`policy-wrap` 是页脚（内容由AI生成…京ICP备…），长度还比答案长 ——
如果按「最长文本块」取答案，会稳定地取到页脚。这是当前 driver 最大的风险点。

**当前取值**：`answerSelectors: ['[class*="question-txt"] ~ * p', '.chat-message p', 'p']`
—— 优先用「问题气泡之后的段落」这个结构关系，再逐级放宽。

---

## 3. 发送方式：键盘，不是点击

发送控件是纯 SVG，无 class / 无 aria-label / 无文字，所有文本启发式都提不出来。
实测 **Enter 键提交成功**。因此 `sendSelectors` 留空，由 driver 走键盘路径。

## 4. 其它信号

- **完成信号**：正文流末尾出现「思考结束」。`inProgressPatterns: [/思考中/]`
- **引用口径**：本次回答无任何自陈引用数量的文案（「搜索 N 个关键词 / 参考 M 篇资料」
  未出现，54 字纯自述）⇒ `citation.tier` 保持 `DOM_ONLY`。
  升级到 `SELF_REPORTED_COUNT` 需要在一次**带检索**的提问上实测。
- **会话 URL**：始终停在 `/main/alltoolsdetail?lang=zh`，未观察到会话 id 进入路径
  ⇒ `conversationUrlPattern` 留空，不猜。

---

## 5. 2026-09-28 补充：撞到「访问验证」页

第一次 Phase 0 只跑了两条短问题，没触发检索。放到真实批量下才暴露平台的速率型风控。

### 现象

连续 9 次提问（间隔 15-33 秒）全部成功，紧接着一个 4 题批次立刻三次重试全失败，报「输入框不可点击」。

进容器探针一查，真因与表象无关：

```
访问验证 别离开，为了更好的访问体验，请进行验证，通过后即可继续访问网页
```

**`textarea` 仍在 DOM 里，但尺寸是 0×0。** 页面被平台的风控页整个换掉了。

### 由此产生的两个改动

**1. driver 必须先判风控，再判弹层。** 元素存在性和可点性都区分不出「被弹层遮挡」和「被风控页替换」——前者清掉弹层就能继续，后者只能等平台放行。处置相反，判错一次就把窗口堵死。

现在 `openZhipu` 先跑 `pageGate()`，识别到验证墙就抛 `VERIFICATION_REQUIRED`。它映射到 `manual: true`，worker 会停止自动运行而不是立刻重试——早先抛 `PAGE_CHANGED` 时 worker 当作「页面结构错乱」重试三次，每次都再撞一次。

**2. 节奏按累积量收紧，不是按单题频率。** 分界线是「连续提问攒了多少」而不是「一次间隔多久」：15-33 秒能连跑 9 次，但 9 次之后再来一批就撞墙。这与千问「当天累计约 37 次后弹登录墙」同形（`MULTI_PLATFORM_LESSONS.md` §4）。

所以 `limits` 收紧到 `minDelayMs: 60000` / `maxDelayMs: 120000`，量级保持保守。撞墙后的恢复要等 20-30 分钟且会自己退，硬顶只会把剩下的问题一条条烧掉。

### 同时补上的登记

`quota.exhaustedPatterns` 登记了访问验证文案。**这一步不是可选的**：认不出撞墙就只能记成 TIMEOUT，报告和告警读不出真相，而真处置是「等平台放行」，和「选择器失配」完全不同。

## 6. 为什么最初判成 validated: false，以及后来为什么打开

一开始不注册，理由是「答案容器没有稳定标识、同页页脚比答案更长」。那个理由成立——按「取最长文本块」会稳定读到 101 字符的 `policy-wrap` 而漏掉 54 字符的答案，且看起来仍是成功。

后来打开了，因为 `src/zhipu.js` 正面解决了它：按「问题气泡之后的对话容器」取全文并显式排除 `.policy-wrap`。那条限制由 driver 承担，不是被绕过。

打开它的同时修掉了三个**看起来是成功的错误**，它们都不会报错，只会让报告静默失真：

| 错误 | 症状 | 根因 |
|---|---|---|
| 完成判据永不触发 | 每条耗满 420 秒预算，最后交出 188 字符的**英文思考过程** | `snapshot.answer === lastLength` 拿字符串比数字，恒为 false |
| 答案被截成 181 字符 | 表格和来源全丢 | 智谱把答案渲染成多个 `<p>`，只取了最长的一个 |
| 答案只剩 2 字符「语音」 | run 状态 success，内容是纯 UI 噪声 | 全局正则删 `ChatGLM`，把正文里的产品名也删了 |

**不要因为「本地跑通了一次」就把它翻成 true。** 那正是这份记录存在的理由。

## 7. 引用口径已在第二次实测中升级

第一次实测用了一道 54 字的自我介绍题，没触发检索，所以判 `DOM_ONLY`——那是「没观测到」，不是「不存在」。

第二次换带检索的问题（新能源汽车销量排名、局域网与广域网区别），观察到两件事：

- 平台**会**自陈来源数量，句式是「N个来源」（实测「19个来源」「10个来源」）；
- 来源是**裸域名角标**（`askci.com`、`lbkrs.com`、`biggo.com.tw`），不是 `<a>` 标签——
  `querySelectorAll("a[href^='http']")` 恒为 0。

所以 `citation.tier` 升到 `SELF_REPORTED_COUNT`，`countPattern: /(\d+)\s*个来源/`。driver 从答案正文解析域名，`url` 一律填域名根 URL 并标注 `captured_from: "角标域名"`——`db/persist.js` 的 `prepareCitations` 会把缺 url 的引用整个 skip 掉，不给 url 就会出现「采到了域名却一条没落库」。

**这三条教训合起来是这个平台接入的核心**：`getByText` 与可点性都不可靠（前者漏、无障碍标签缺失），必须靠结构关系和尺寸；平台自陈的元数据（一句话介绍、"19个来源"）比 DOM 结构可靠得多。
