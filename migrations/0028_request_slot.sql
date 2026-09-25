-- 记录一次采集跑在哪个并发槽位上：指纹轮换的计数要按槽位分开算。
--
-- 背景：ONEGL_ACCOUNT_SLOTS 允许同一个（无凭证的）账号并排跑多个浏览器，每个槽位持有自己
-- 的浏览器进程和指纹。身份轮换的计数取自「该槽位已服务过多少条」，若 N 个槽位共用一个全局
-- 计数，它们会在同一位置一起触发轮换 —— 等于把 N 个浏览器同时重启，槽位隔离也就没有意义了。
--
-- 为什么不做成按 selection_index 取模的推导列：那假设了采样顺序与调度顺序一致。任务被
-- delay 重排、被人工 promote、或批次续跑时这个假设不成立，槽位归属会静默错位。实际用哪个
-- 槽位是运行时事实，就按事实落库。
--
-- 存量行全部为 0：改造前只有一个槽位，这与当时的真实情况一致。
ALTER TABLE runs
  ADD COLUMN request_slot integer NOT NULL DEFAULT 0;

-- 按槽位统计服务量是轮换判据的热路径（每次提问前一次），走这个索引。
CREATE INDEX runs_batch_slot_idx
  ON runs (sampling_batch_id, account_key, provider, request_slot);
