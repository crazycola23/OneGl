# OneGl Brand & Citation Intelligence Reporting

OneGl 的主报告不是用来先问“GEO 得多少分”，而是回答一次 AI 搜索中最直接的品牌与引用情报问题。

## 主分析顺序

报告主视图固定围绕下面的数据链：

```text
搜索问题 / Prompt
  -> AI 回答是否出现目标品牌
  -> AI 最终展示了哪些引用 URL
  -> 这些 URL 主要来自哪些域名
  -> 被引用文章讲了什么、是什么内容类型
  -> 被引用文章通常是什么结构
  -> 哪些被引用文章本身包含目标品牌
```

GEO 综合准备度、Prompt Opportunity、Candidate -> Citation 因子 uplift 等内容保留，但全部降为二级诊断和实验辅助。

## 1. Query Intelligence：当前问题里有没有目标品牌

按 `Prompt + category` 汇总有效 Run，核心字段包括：

- 搜索问题；
- 问题分类；
- 有效 Run 数；
- AI 回答中目标品牌出现的 Run 数与提及率；
- AI 回答片段；
- 唯一可见引用页数量；
- 同一批回答中有多少引用页本身包含目标品牌；
- 主要引用来源。

这里明确区分：

- **AI Answer Brand Mention**：AI 最终回答本身是否出现目标品牌；
- **Source Page Brand Mention**：AI 引用的第三方页面正文是否出现目标品牌。

两者不能混为一个指标。

## 2. Citation Source Intelligence：AI 主要引用哪里

报告同时提供两层来源视图。

### 域名层

回答“AI 在这一批问题里主要从哪些站拿资料”：

- 域名；
- 引用次数；
- 唯一文章数；
- 涉及 Prompt 数；
- 其中有多少引用文章包含目标品牌。

### URL 层

回答“具体是哪些文章”：

- 文章标题；
- Canonical / Final URL；
- 域名；
- 被引用次数；
- 涉及 Prompt 数；
- 页面是否出现目标品牌；
- 页面内容类型与结构标签；
- 可展开的文章内容摘要；
- 可展开的 H1/H2/H3 标题结构。

引用排行以真实可见 citation 为基础，不拿 retrieval candidate 冒充最终引用。

## 3. Cited Content Intelligence：被引用文章都写了什么

对于成功抓取的最终引用页，OneGl 只保存紧凑的派生证据，不保存整页第三方 HTML 或完整正文。

当前派生内容包括：

- 最长约 1200 字符的正文摘要；
- H1/H2/H3 标题层级；
- 段落数；
- 正文长度；
- 表格、列表、FAQ 等结构信号；
- 作者、发布日期/更新时间信号；
- Schema 类型；
- 启发式内容类型。

当前内容类型包括：

- `informational`
- `recommendation_list`
- `comparison`
- `review`
- `how_to`
- `faq`
- `news`

这些类型用于描述样本，不代表平台官方分类或权重。

## 4. Structure Intelligence：AI 引用文章通常是什么结构

报告对成功分析的唯一引用页聚合：

- 页面分析覆盖率；
- 有 H2 的比例；
- 有列表的比例；
- 有表格的比例；
- 有 FAQ 的比例；
- 有作者信息的比例；
- 有发布日期信号的比例；
- 平均正文长度；
- 平均 H2 数量；
- 最常见内容类型；
- 最常见结构组合，例如 `H1 + H2 + LIST`。

这些数字回答的是“当前真实被引页面大多长什么样”，不自动等于“加表格就能提高引用率”。因果判断仍需要后面的 Candidate -> Citation 实验层。

## 5. Brand Evidence Sources：哪些引用文章本身提到了品牌

这是品牌情报的核心视图之一。

对于每个已分析且包含目标品牌的引用页，报告展示：

- URL / 标题；
- AI 引用次数；
- 涉及 Prompt 数；
- 页面内品牌出现次数；
- 品牌出现位置：title / meta / h1 / h2 / h3 / body；
- 小段品牌上下文；
- 命中的品牌名、别名或产品别名。

页面品牌检测与 AI 回答品牌检测复用同一套显式规则：目标品牌、品牌别名、产品别名和排除正则，避免两套口径互相打架。

## 引用页内容采集

数据库迁移完成后，可对某个批次真正被 AI 引用的页面做内容分析：

```bash
npm run db:migrate
npm run source:intelligence -- --batch <id>
```

可选：

```bash
npm run source:intelligence -- --batch <id> --refresh
npm run source:intelligence -- --batch <id> --limit 50
```

该流程只处理该批次的**最终可见引用文章**，不是把几百个 retrieval candidates 全部混入主报告。

抓取遵循现有 OneGl 的安全边界：公共 HTTP(S) URL、私网/回环拦截、robots 检查、大小/超时限制和域级请求间隔。

未运行内容分析或页面抓取失败时，页面品牌证据与内容结构显示 `N/A` / 未采集，而不是误报成“页面没有品牌”或“结构分为 0”。

## 归因边界

OneGl 可以观察：

```text
同一个有效 Run
  -> AI 回答有没有品牌
  -> 最终展示了哪些 citation
  -> citation 页面本身有没有品牌
```

但如果平台没有提供句子级/claim 级 source provenance，OneGl **不会**自动声称：

```text
URL A 导致了 AI 提到品牌
```

正确措辞是“该引用页与品牌提及在同一回答中共同出现”或“该引用页本身包含品牌证据”。

## 二级：Prompt 优化机会

Prompt Opportunity Matrix 继续保留，但不再是主报告入口。

| 状态 | 优先级 | 含义 |
|---|---|---|
| `DATA_GAP` | P0 | 没有有效 Run，先补数据 |
| `NO_MENTION` | P1 | 有有效 Run，但 AI 0 次提品牌 |
| `WEAK_MENTION` | P1 | AI 品牌提及率 < 50% |
| `UNSTABLE_MENTION` | P2 | 提及率在 50%–100% 之间 |
| `STABLE_MENTION` | WATCH | 当前有效 Run 全部提及 |

引用密度只是上下文，不是 Prompt 机会质量分。

## 二级：GEO 调优诊断与实验层

原有以下指标继续用于补充判断：

- 数据质量；
- Prompt / Run 品牌覆盖；
- 最弱意图；
- 来源 HHI / 集中度；
- 目标文章引用表现；
- Candidate -> Citation 匹配；
- 页面因子 Evidence Gate；
- FDR 校正后的探索性页面因素；
- 内部综合准备度趋势分。

解释顺序仍遵循：

```text
Outcome -> Diagnostic -> Evidence -> Action
```

但这一整层现在位于品牌与引用情报主视图之后。

## 缺失值语义

OneGl 明确区分 `0` 和 `N/A`：

- `0` / `0%`：有合法分母，真实观测为 0；
- `N/A`：未配置、未抓取、无合法分母或证据层尚未建立；
- 页面未成功分析时，不能把“品牌未知”当成“品牌不存在”；
- 未配置目标文章时 `0 / 0` 不得显示为 `0%`；
- 没有引用来源时，不能把“来源多样性未知”解释成“来源多样性差”。

## HTML 报告与 Dashboard

批次详情页 `/batches/<id>` 的显示顺序现在是：

1. **AI 搜索品牌与引用情报**；
2. 二级 GEO 调优诊断；
3. 批次执行和原始观测详情。

浏览器中的 **预览报告 / 生成 HTML 报告** 使用同一套 intelligence 数据与渲染逻辑。

命令行仍支持：

```bash
npm run report:export -- --batch <id>
npm run report:html -- <snapshot.json> <report.html>
```

## 目标

OneGl 当前的主要产品问题不是：

> “我的 GEO 分是多少？”

而是：

> “当用户问这些问题时，AI 有没有我的品牌；它引用了哪些文章；这些文章来自哪里、写了什么、是什么结构；哪些被引文章本身已经在传播我的品牌？”

评分和因子分析服务于这个证据链，而不是反过来让证据链服务于一个总分。
