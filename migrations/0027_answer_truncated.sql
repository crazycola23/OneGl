-- 回答是否在生成中途被截断：这是采集缺陷，不是结论。
--
-- 平台会在生成中途长时间静止（实测一条回答在 104 字上停了 56 秒才继续写到 816 字），
-- 所以"文本安静"型判据仍可能提前收尾，留下半句话。把这种行标记出来，报告才能把它们
-- 单列或排除，而不是当作完整观测混进品牌提及率与引用率。
ALTER TABLE runs
  ADD COLUMN answer_truncated boolean NOT NULL DEFAULT false;
