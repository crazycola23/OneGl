# Customer Dashboard API

OneGl 的客户前台建议优先使用：

```http
GET /v1/tasks/{task_id}/dashboard?days=30&question_limit=100
```

这个接口是给 GEO SaaS 前端直接消费的聚合层。主平台只需要保存 OneGl 的公开 ID（`tsk_`、`exe_`、`res_`、`rpt_`），不需要知道内部 `project_id`、`batch_id`、`prompt_id` 或浏览器账号 key。

## 页面怎么用

### 顶部 KPI

读取 `overview`：

- `visibility_rate`：目标品牌在有效豆包回答中的出现比例。
- `share_of_voice`：目标品牌在“品牌 + 已配置竞品”提及单位中的占比。
- `visible_citations`：豆包回答中实际对用户可见的引用数量。
- `cited_domains`：窗口内被引用的不同域名数。
- `citation_stability_score`：引用来源稳定度，0–100；数据不足时为 `null`。
- `query_fanout_total` / `query_fanout_unique`：豆包真实发出的搜索改写数量。
- `source_pages_analyzed` / `source_analysis_coverage_rate`：已分析引用页面及覆盖率。

比例统一使用 `0..1`。未知或样本不足使用 `null`，不伪装成 0。

### 趋势图

读取 `trends.visibility` 和 `trends.share_of_voice`。

每个点按日期返回，前端无需自己把 run 聚合成日数据。

### 竞品表

读取 `competitors`：

- `mentions`
- `mention_rate`
- `share_of_voice`

这里的竞品来自该 Task 底层项目已经配置的竞品规则。

### 引用来源

读取 `citations.top_domains` 和 `citations.stability`。

`citation_landscape` / `stability.difficulty` 是 OneGl 的启发式标签：

- `wide-open`
- `contested`
- `locked-in`
- `insufficient-data`

它不是豆包官方指标。

### 豆包真实搜索 Query

读取 `search_queries.top_queries`。

这些 Query 来自已保存的真实采集证据；OneGl 不会为了补数据而编造搜索词。

### 引用页面结构

读取 `source_content`。

这里展示 H2、表格、列表、FAQ、作者、发布日期等在“豆包实际引用页面”中的共现情况。它只表示观测相关性，不表示这些结构会导致豆包引用。

### 问题列表

读取 `questions`。

每个问题包含窗口内：

- 品牌可见率
- 最强竞品及竞品提及率
- 可见率差距
- 最近一次 `latest_result`

如果用户点击“查看本次豆包回答”，继续请求：

```http
GET /v1/results/{result_id}
```

完整回答正文和逐条引用仍由 Result API 提供，Dashboard 不重复携带大段回答文本。

`question_limit` 默认 100，最大 500。`meta.questions_truncated=true` 时，说明 Dashboard 只返回了优先问题子集；Task 原始问题池和 Execution Result 列表仍可通过原有接口获取。

### GEO 机会

读取 `opportunities`。

`source` 说明机会来自：

- `geo`：可见率、竞品、Query Fan-out、引用来源等 GEO 测量。
- `cited_page`：实际引用页面的观测证据。

机会是证据摘要，不是对豆包内部算法的推断。

## 典型返回结构

```json
{
  "data": {
    "task": {
      "task_id": "tsk_...",
      "external_id": "your-project-id",
      "name": "品牌 GEO 监测",
      "target_brand": "品牌A",
      "platforms": ["doubao"],
      "state": "active"
    },
    "period": {
      "days": 30,
      "from": "2026-08-17T00:00:00.000Z",
      "to": "2026-09-16T00:00:00.000Z"
    },
    "latest_execution": {},
    "overview": {},
    "trends": {
      "visibility": [],
      "share_of_voice": []
    },
    "competitors": [],
    "citations": {},
    "search_queries": {},
    "source_content": {},
    "questions": [],
    "opportunities": [],
    "meta": {}
  }
}
```

## 不会返回的内容

Dashboard 故意不返回：

- PostgreSQL 内部 project/batch/prompt 数字 ID
- `account_key`
- Cookie / storageState
- 浏览器选择器或任意 browser-control 参数
- 原始第三方 HTML
- 豆包验证绕过相关能力

这些都不应该成为客户前端契约的一部分。
