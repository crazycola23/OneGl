-- OneGl v0.5 — 后台队列与账号安全层
--
-- 全部为新增列，不重建、不删除任何已有数据。

-- ---------------------------------------------------------------- 批次进度
ALTER TABLE sampling_batches ADD COLUMN queued_at          timestamptz;
ALTER TABLE sampling_batches ADD COLUMN aborted_at         timestamptz;
ALTER TABLE sampling_batches ADD COLUMN last_heartbeat_at  timestamptz;
ALTER TABLE sampling_batches ADD COLUMN requested_jobs     integer NOT NULL DEFAULT 0;
ALTER TABLE sampling_batches ADD COLUMN completed_jobs     integer NOT NULL DEFAULT 0;
ALTER TABLE sampling_batches ADD COLUMN failed_jobs        integer NOT NULL DEFAULT 0;
-- 因账号被暂停或人工停止而没有执行的分配。不计入失败，但要计入分母，
-- 否则「请求 100 个」会看起来像「执行了 100 个」。
ALTER TABLE sampling_batches ADD COLUMN skipped_jobs       integer NOT NULL DEFAULT 0;

ALTER TABLE sampling_batches DROP CONSTRAINT IF EXISTS sampling_batches_status_check;
ALTER TABLE sampling_batches ADD CONSTRAINT sampling_batches_status_check
  CHECK (status IN ('pending', 'queued', 'running', 'completed', 'partial', 'failed', 'aborted'));

-- 回填已有批次，让进度条立刻可用
UPDATE sampling_batches b
   SET requested_jobs = (SELECT count(*) FROM sampling_batch_prompts WHERE batch_id = b.id),
       completed_jobs = (SELECT count(*) FROM runs r
                          WHERE r.sampling_batch_id = b.id AND r.status IN ('success', 'partial')),
       failed_jobs    = (SELECT count(*) FROM runs r
                          WHERE r.sampling_batch_id = b.id AND r.status = 'failed');

-- ---------------------------------------------------------------- 账号安全层
-- 只保存派生状态与计数。Cookie / storageState 永远留在服务器本地文件里。
ALTER TABLE accounts ADD COLUMN status                  text        NOT NULL DEFAULT 'unknown';
ALTER TABLE accounts ADD COLUMN last_run_at             timestamptz;
ALTER TABLE accounts ADD COLUMN runs_today              integer     NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN runs_today_date         date;
ALTER TABLE accounts ADD COLUMN consecutive_failures    integer     NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN cooldown_until          timestamptz;
ALTER TABLE accounts ADD COLUMN paused_at               timestamptz;
ALTER TABLE accounts ADD COLUMN pause_reason            text;
ALTER TABLE accounts ADD COLUMN last_error_code         text;
ALTER TABLE accounts ADD COLUMN storage_state_present   boolean     NOT NULL DEFAULT false;

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_status_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_status_check CHECK (status IN (
  'unknown',
  'healthy',
  'cooldown',
  'paused',
  'disabled',
  'login_required',
  'session_expired',
  'verification_required',
  'access_restricted',
  'rate_limited'
));

CREATE INDEX accounts_status_idx ON accounts (status);

-- ---------------------------------------------------------------- 运行幂等键
-- run_token 每个「批次 + 分配序号」唯一，保证队列重试或重复点击都不会产生第二条 Run。
ALTER TABLE runs ADD COLUMN run_token text;
ALTER TABLE runs ADD COLUMN job_id    text;
ALTER TABLE runs ADD COLUMN attempt   integer NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX runs_run_token_key ON runs (run_token) WHERE run_token IS NOT NULL;
CREATE INDEX runs_job_id_idx ON runs (job_id);
