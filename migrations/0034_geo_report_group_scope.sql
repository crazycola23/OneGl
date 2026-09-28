-- 跨平台 GEO 报告：让一份报告归属任务组（横跨多个采集任务）而不是单个 task。
--
-- ## 背景
--
-- service_geo_reports.task_id 是 NOT NULL 且外键指向 service_tasks，天然只能表达
-- 「一个采集任务」。但 GEO 里一个用户任务可以同时投多个平台，每个平台一个采集
-- task，报告要按平台横排就必须一次覆盖多个 task。
--
-- ## 做法
--
-- 加一个可空的 group_id，用 CHECK 保证 task_id 和 group_id 恰好有一个非空：
-- 报告要么属于单个采集任务，要么属于任务组，二者互斥。不允许两个都空
-- （无法定位来源），也不允许两个都有（口径会歧义）。
--
-- 保留 task_id 原有语义和 NOT NULL 之外的行为不变：单任务报告的读路径、
-- 索引、既有数据全部照旧，不需要任何数据迁移。

-- task_id 原本是 NOT NULL，但组报告没有唯一的采集 task，必须允许为空。
-- 放宽由下面的 CHECK 兜底：task_id 与 group_id 恰好有一个非空，
-- 所以「既不属任务也不属组」这种无主报告进不来。
ALTER TABLE service_geo_reports
  ALTER COLUMN task_id DROP NOT NULL;

ALTER TABLE service_geo_reports
  ADD COLUMN group_id bigint REFERENCES service_task_groups (id) ON DELETE CASCADE;

-- 恰好一个归属。单任务报告维持原有行为，组报告走 group_id。
ALTER TABLE service_geo_reports
  ADD CONSTRAINT service_geo_reports_scope_check
  CHECK ((task_id IS NOT NULL) <> (group_id IS NOT NULL));

-- 组维度列表：GEO 侧按任务组拉取它名下所有快照做纵向对比时走这个索引。
CREATE INDEX service_geo_reports_group_idx ON service_geo_reports (tenant_id, group_id, id DESC);

-- 任务路径的原有索引保留，这里补一条让「单任务 + 组」都能按时间倒序取全。
CREATE INDEX service_geo_reports_scope_recent_idx ON service_geo_reports (tenant_id, id DESC);
