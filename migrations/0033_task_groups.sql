-- 任务组：一个用户视角的「任务」可以横跨多个采集任务，每个采集任务对应一个平台。
--
-- ## 为什么需要它
--
-- 现状是 service_tasks.project_id 上有 UNIQUE，一个 project 只能挂一个 task，
-- 而 sampling_batches 通过 project 归属、execution 通过 task 归属。于是「一个任务
-- 同时投千问和豆包」在数据层被强制拆成两个 task，而报告口径（periodBatches 用
-- e.task_id 过滤）永远只能看到一个平台。
--
-- 但报告层本身早就是多平台的：request.platforms 是数组，period.platforms 按平台
-- 逐个聚合。也就是说多平台横排是报告层原生能力，缺的只是「把多个 task 归到一个
-- 用户概念下」这一层。
--
-- ## 为什么用组而不是改掉 UNIQUE
--
-- 去掉 project_id 的 UNIQUE 会波及所有以 task→project 一对一为前提的查询
-- （taskAndProject 是 t.project_id = p.id 的直接 join，几十处引用）。加一层组是
-- 纯增量：现有 task 语义、现有 API、现有报告全部不变，只是多了一个可选的聚合维度。
--
-- ## 平台的唯一来源仍然是 task.platforms
--
-- 组本身不声明平台。组的平台 = 成员 task 的 platforms 之和。这样不会出现
-- 「组说支持豆包但底下没有豆包 task」这种无法验证的声明。横向对比时按
-- platform 去重合并：同组内两个 task 都含 doubao，合并成一列，因为横排的语义
-- 是「这个任务在各平台的表现」，不是「每个采集任务一列」。

CREATE TABLE service_task_groups (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id   text        NOT NULL UNIQUE,
  tenant_id   bigint      NOT NULL REFERENCES service_tenants (id) ON DELETE CASCADE,
  name        text        NOT NULL,
  -- 客户视角的任务身份。同一品牌/门店的多次采集应复用同一个 external_id，
  -- 这样 GEO 侧可以按它把多个快照串成一条纵向线索。
  external_id text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX service_task_groups_tenant_idx ON service_task_groups (tenant_id, id DESC);
-- 同一租户下 external_id 唯一：它是跨快照关联的键，重了会让对比端点认错任务。
CREATE UNIQUE INDEX service_task_groups_external_key
  ON service_task_groups (tenant_id, external_id)
  WHERE external_id IS NOT NULL;

-- 成员关系。task 侧是「最多属于一个组」：一个采集任务同时挂两个组会让报告口径
-- 无法确定该取哪一边，所以这里用 UNIQUE 而不是普通索引。
CREATE TABLE service_task_group_members (
  group_id  bigint      NOT NULL REFERENCES service_task_groups (id) ON DELETE CASCADE,
  task_id   bigint      NOT NULL REFERENCES service_tasks (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_task_group_members_key UNIQUE (task_id),
  CONSTRAINT service_task_group_members_pair UNIQUE (group_id, task_id)
);

CREATE INDEX service_task_group_members_group_idx ON service_task_group_members (group_id);

-- 组标签（可选）。刻意存成 jsonb 而不是独立表：标签只用于筛选和展示，
-- 不参与任何口径计算，独立表会带来无谓的写放大。
ALTER TABLE service_task_groups
  ADD COLUMN tags jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE service_task_groups
  ADD CONSTRAINT service_task_groups_tags_check CHECK (jsonb_typeof(tags) = 'array');

-- updated_at 交给触发器维护，和仓库里其他表的做法保持一致，避免调用方漏更新。
CREATE OR REPLACE FUNCTION service_task_groups_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER service_task_groups_touch
  BEFORE UPDATE ON service_task_groups
  FOR EACH ROW EXECUTE FUNCTION service_task_groups_touch_updated_at();
