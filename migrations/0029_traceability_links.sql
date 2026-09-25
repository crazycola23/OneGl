-- 0029: 数据溯源补强 —— 让「时间 / 平台 / 原始任务」都是关系而不是字符串解析。
--
-- 背景（2026-09-25 实测）：从一条 citation 往上追时发现三处缺口。
--
--   1. `sampling_batches` 没有 task 外键，只能从 `name` 字符串里抠出 `exe_xxxx` 再反查
--      `service_task_executions`。批次命名格式一改就断，而且没有约束保证它指向真实存在的
--      task —— 「这条数据属于哪个原始任务」本该是外键，不该是字符串解析。
--
--   2. `citations` 没有 provider，平台维度只能靠 run_id JOIN `runs` 取得。
--      而 citations 正是要单独交给运营分析的那张表，导出即丢平台维度。
--
--   3. `runs.started_at` 在重试时不更新：保持首次尝试时间，`finished_at` 却更新成
--      最后一次成功的时间。实测出现过 `19:10:20 ~ 23:11:48` 这种 4 小时的"耗时"，
--      而那条实际只跑了几分钟。于是**任何用 finished_at - started_at 算耗时的查询，
--      在被重试过的记录上都严重失真**（此前给出的"平均耗时/单条 dur"都受此影响）。
--      这里加一列记录最后一次尝试的开始时刻，保留 started_at 作为「首次见到这条任务」的时刻，
--      两个语义分开，不再让一个字段承担两种含义。
--
-- 三处都是可空列 + 回填，不改既有行的语义；约束用 NOT VALID 加，避免在长表上锁表扫描。
--
-- 注意：**不要在这里写 BEGIN/COMMIT**。既有的 0027/0028 都没有显式事务，说明 migrate.js
-- 自己把每个迁移包在一个事务里 —— 这里再开一个会变成嵌套事务直接报错。

-- 1) 批次 → 原始任务（可空：历史批次没有这个信息，回填不出来）
ALTER TABLE sampling_batches
  ADD COLUMN IF NOT EXISTS task_id bigint;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sampling_batches_task_id_fkey'
  ) THEN
    ALTER TABLE sampling_batches
      ADD CONSTRAINT sampling_batches_task_id_fkey
      FOREIGN KEY (task_id) REFERENCES service_tasks(id) ON DELETE SET NULL
      NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS sampling_batches_task_idx
  ON sampling_batches (task_id) WHERE task_id IS NOT NULL;

-- 2) 引用自带平台维度（回填自 runs.provider）
ALTER TABLE citations
  ADD COLUMN IF NOT EXISTS provider text;

UPDATE citations c
   SET provider = r.provider
  FROM runs r
 WHERE r.id = c.run_id
   AND c.provider IS NULL;

CREATE INDEX IF NOT EXISTS citations_provider_idx
  ON citations (provider, created_at DESC);

-- 3) 最后一次尝试的开始时刻（与 started_at 的语义分开）
ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS last_attempt_started_at timestamp with time zone;

UPDATE runs
   SET last_attempt_started_at = started_at
 WHERE last_attempt_started_at IS NULL;

-- 回滚（单独执行，不要和上面放一起）：
--   DROP INDEX IF EXISTS citations_provider_idx;
--   ALTER TABLE citations DROP COLUMN IF EXISTS provider;
--   DROP INDEX IF EXISTS sampling_batches_task_idx;
--   ALTER TABLE sampling_batches DROP CONSTRAINT IF EXISTS sampling_batches_task_id_fkey;
--   ALTER TABLE sampling_batches DROP COLUMN IF EXISTS task_id;
--   ALTER TABLE runs DROP COLUMN IF EXISTS last_attempt_started_at;
