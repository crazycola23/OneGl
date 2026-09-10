-- OneGl v0.4 — 关键词池的录入、启停与删除
--
-- 两个设计决定，都是为了「删除关键词不能破坏历史」：
--
-- 1. 软删除。prompts 不会真的被删除，只打上 deleted_at。
--    runs.prompt_id 是 ON DELETE CASCADE，硬删会让历史 Run 一起消失。
--    软删除之后，运行记录、引用、批次全部保持完整。
--
-- 2. 批次内快照。抽样时把关键词正文抄一份到 sampling_batch_prompts。
--    这样即使以后关键词被改名、禁用或删除，历史 Batch 显示的仍然是
--    当时真正被抽中的那句话。

ALTER TABLE prompts ADD COLUMN deleted_at timestamptz;

CREATE INDEX prompts_deleted_at_idx ON prompts (deleted_at);

-- 关键词池列表与抽样都只关心未删除的行，按项目过滤时走这个组合索引
CREATE INDEX prompts_project_alive_idx ON prompts (project_id, deleted_at) WHERE enabled;

ALTER TABLE sampling_batch_prompts ADD COLUMN prompt_text text;
ALTER TABLE sampling_batch_prompts ADD COLUMN prompt_md5  text;

-- 回填已有的批次记录，让快照从现在开始成立
UPDATE sampling_batch_prompts sbp
   SET prompt_text = p.prompt,
       prompt_md5  = md5(p.prompt)
  FROM prompts p
 WHERE p.id = sbp.prompt_id
   AND sbp.prompt_text IS NULL;
