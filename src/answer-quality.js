/**
 * 回答是否"看起来被截断"——一个**提示**，不是判决。
 *
 * 平台会在生成中途长时间静止（实测一条回答在 104 字上停了 56 秒才继续写到 816 字），所以
 * 以"文本安静"判完成的采集仍可能提前收尾，留下半句话。这种行必须能被看见：把它们混进品牌
 * 提及率、引用率，等于用一个不存在的答案去描述平台。
 *
 * 判据刻意保守：结尾不是句末标点就标记（列表、表格合理地以非标点收尾时也会被标），因此它是
 * 标签而不是拒收——排除与否由消费方决定。
 */
const SENTENCE_END = /[。！？…!?；;：:）)】》」』"'\]]$/;

export function looksTruncatedAnswer(text) {
  const value = String(text ?? "").trim();
  if (!value) return false;
  // Length is deliberately not part of the rule: a fragment ("…从专业的中") and a complete short
  // sentence ("推荐思邈棠。") differ by punctuation, not by how many characters they have.
  return !SENTENCE_END.test(value);
}
