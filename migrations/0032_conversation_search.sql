-- 对话档案页需要的检索能力：跨「问题 + 回答」的中文子串检索。
--
-- 为什么要 pg_trgm 而不是 tsvector：
--   tsvector 的 simple 配置按空格切词，中文没有空格，一整句会变成一个词元，
--   搜「推拿」匹配不上「越城区中医推拿哪家口碑好」。实测该方案的召回是坏的。
--   pg_trgm 对中文按字符三元组建索引，任意子串都能命中，这才是运营真正要的语义。
--
-- 为什么用触发器而不是生成列：
--   生成列的表达式里不允许子查询，而「问题」在 prompts 表、「回答」在 runs 表。
--   实测 `cannot use subquery in column generation expression`。
--   触发器在两条写入路径（采集持久化、批次重放）上都会生效，search_text 不会漏。
--
-- 取值口径：只拼「问题 + 回答」，不含引用标题。
-- 引用标题属于证据而不是对话内容，混进来会让搜「携程」命中一条正文完全没提携程的回答。

CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE runs
  ADD COLUMN search_text text;  -- 问题 + 回答的合并检索文本，由触发器维护，供对话档案页中文子串检索

-- prompts.prompt 与 runs.answer 的任一变更都要同步重算。
CREATE OR REPLACE FUNCTION runs_refresh_search_text() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_text := COALESCE(NEW.answer, '') || ' ' || COALESCE(
    (SELECT p.prompt FROM prompts p WHERE p.id = NEW.prompt_id), '');
  RETURN NEW;
END;
$$;

CREATE TRIGGER runs_search_text_biu
  BEFORE INSERT OR UPDATE OF answer, prompt_id ON runs
  FOR EACH ROW EXECUTE FUNCTION runs_refresh_search_text();

-- 存量回填：触发器只对之后发生的写入生效，历史行必须显式补一次。
-- 先装函数与触发器再回填，避免回填窗口内的新写入被漏掉。
UPDATE runs SET answer = answer;

-- 中文子串检索入口。
CREATE INDEX runs_search_text_trgm_idx
  ON runs USING gin (search_text gin_trgm_ops);

-- 档案页按批次倒序翻页的服务索引，避免每次都在 sampling_batch_id 上再排一次。
CREATE INDEX runs_batch_started_idx
  ON runs (sampling_batch_id, started_at DESC);
