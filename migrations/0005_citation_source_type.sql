-- OneGl — 引用来源类型
--
-- 运行时早就区分了这两类来源，但数据库里没有落下来，于是「用户可见的引用」和
-- 「抓到但没能确认 UI 可见的来源」在库里长得一模一样，事后无法区分。
--
--   visible    豆包回答里对最终用户可见的引用来源。当前 DOM 抓取全部属于这一类。
--   retrieved  通过其它通道（未来可能接的 Network / SSE）拿到、但无法确认用户可见的来源。
--
-- 现在只新增列与约束，不写入任何 retrieved 数据，也不接入新的抓取通道。
-- 「Retrieved Source 自动升级为 Citation」是被明确禁止的行为：来源类型一旦是
-- retrieved，就需要人工或后续规则确认，绝不能默认当成可见引用参与统计。
--
-- Answer 与 Citation 之间是否确认关联，继续由 relation_status 表达，与此列无关。

ALTER TABLE citations ADD COLUMN source_type text NOT NULL DEFAULT 'visible';

ALTER TABLE citations ADD CONSTRAINT citations_source_type_check
  CHECK (source_type IN ('visible', 'retrieved'));

-- 引用来源统计会按来源类型过滤，避免把 retrieved 混进「AI 引用收录」口径。
CREATE INDEX citations_source_type_idx ON citations (source_type);
