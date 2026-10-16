-- 记录一次采集实际从哪个出口出去的。
--
-- 为什么单开这几列：2026-10-16 的容量实验要回答的是「一个 IP 能用几次」，
-- 而在此之前库里没有任何出口维度 —— 只能按平台和账号统计，于是
-- 「同一 IP 的第 5 条开始被拒」和「同一账号的第 5 条开始被拒」在数据上长得一模一样，
-- 没法区分「限制按 IP 记」还是「限制按账号记」，采购决策也就没有依据。
--
-- observed_egress_ip 只能来自一次**实测**（Node 侧 CONNECT 探针，或浏览器导航取到的回显）。
-- 绝不能填供应商返回的 host —— 那是入口地址：两个入口可能落到同一个出口，一个入口也可能
-- 在供应商侧被换成别的出口，按入口记账会把预算记到错误的对象上。
--
-- 四列全部允许 NULL：没有配代理池的部署（含所有存量行）本来就没有出口可记，
-- 用默认值编一个出来会让「有代理」和「没代理」在统计里混在一起。

ALTER TABLE runs
  ADD COLUMN proxy_pool_id text,
  ADD COLUMN proxy_exit_id text,
  ADD COLUMN proxy_mode text,
  ADD COLUMN observed_egress_ip inet;

ALTER TABLE runs
  ADD CONSTRAINT runs_proxy_mode_check
    CHECK (proxy_mode IS NULL OR proxy_mode IN ('pooled', 'per_session'));

-- 容量实验的热路径：按平台看「这个出口服务过多少条、从第几条开始不成功」。
CREATE INDEX runs_egress_ip_idx
  ON runs (provider, observed_egress_ip, created_at DESC);
