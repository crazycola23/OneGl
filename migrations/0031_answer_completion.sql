-- 回答是怎么被判定完成的：为什么需要它，而不是把 answer_truncated 当唯一信号。
--
-- `answer_truncated`（0027）是**标点启发式**：结尾不是句末标点就标记。它对千问那类
-- "停在半句话"的截断有效，而实测千问的截断形态正是如此（§3：…体态问、…仓桥直街128）。
--
-- 但它对**另一类**截断在结构上就看不见：平台停在**一句完整的话之后**。文心一言实测就是
-- 这样——它的答案块不是流式增长，而是**反复整块重写**（长度序列
-- 116 → 40 → 9 → 115 → 134 → 36 → 19 → 41）。第一版用"长度稳定 3 轮"判完成，
-- 正好落在重写间隙，收下了 41 字符的**平台收尾追问句**
-- 「需要我为你规划一条西湖区一日游经典路线吗？…」。它以句号结尾，
-- 所以 `answer_truncated` 判它 `false` —— 一条被截断的答案被记成了完整答案。
--
-- 这一列记的是"完成判据本身的可信度"，两者正交：
--   answer_truncated   = 这次收尾的文本**看起来**不完整（标点启发式，可能假阴）
--   answer_completion  = 这次收尾**凭什么**被判定完成（平台信号 / 长度猜测 / 预算耗尽）
--
-- 报告侧要排除"靠长度猜的"那批时看这一列，而不是看 answer_truncated。
--
-- 取值（刻意与 05 枚举不同构，这是采集侧内部事实标识，不是业务枚举）：
--   follow-up-chips           平台给出了明确的收尾信号（文心：追问气泡出现）—— 可信
--   length-stability-fallback 没有平台信号，靠长度稳定猜的 —— **可能截断**
--   timeout                   耗尽预算才返回的 —— 大概率不完整
--   unknown                   旧行 / 平台未上报
--
-- 可空：旧行与未上报的运行必须能与"已上报某个值"区分开。填 'unknown' 会让
-- 「没量到」与「量到是 unknown」在统计上混成一类。
ALTER TABLE runs
  ADD COLUMN answer_completion text;

ALTER TABLE runs ADD CONSTRAINT runs_answer_completion_check
  CHECK (answer_completion IS NULL
         OR answer_completion IN ('follow-up-chips', 'length-stability-fallback',
                                  'timeout', 'unknown'));

-- 支撑"这批数据里有多少是靠猜的"这类回填统计：不按它过滤时全表扫，按它过滤时走索引。
CREATE INDEX runs_answer_completion_idx
  ON runs (answer_completion)
  WHERE answer_completion IS NOT NULL;
