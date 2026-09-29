/**
 * 从渲染好的报告 HTML 里取某一节的纯文本，按**标题**定位。
 *
 * 三个坑，每一个都真实踩过：
 *
 *  1) 按 section id 取（`id="sec-10"`）：删掉三章空占位后编号从 10 变成 7，
 *     `indexOf` 返回 -1，`slice(-1, ...)` 切出空串或乱码，
 *     断言失败时只显示 `actual: ''` —— 看不出是提取失败还是内容缺失。
 *
 *  2) 直接 `indexOf("结论与行动建议")`：命中的第一个是**侧边目录项**
 *     （目录在 <main> 之前），后面的 `lastIndexOf("<section")` 就会
 *     跑到目录之前、返回 -1。
 *
 *  3) 用 `html.indexOf("</section>")` 截断：章节内部还有嵌套的
 *     <section> 时会提前截断（目前结构没有，但改版式就会踩）。
 *
 * 所以：从 <main> 之后开始逐个 <h2> 找标题，命中后回退到本节 <section>，
 * 再用配对计数器跳过嵌套 section。
 */
export function sectionText(html, heading) {
  const main = html.indexOf("<main>");
  if (main < 0) throw new Error("报告里没有 <main>，HTML 结构变了");

  let cursor = main;
  let headingAt = -1;
  for (;;) {
    const h2 = html.indexOf("<h2>", cursor);
    if (h2 < 0) break;
    const close = html.indexOf("</h2>", h2);
    if (html.slice(h2, close).includes(heading)) {
      headingAt = h2;
      break;
    }
    cursor = h2 + 4;
  }
  if (headingAt < 0) {
    throw new Error(`报告正文里找不到「${heading}」这一节`);
  }

  const start = html.lastIndexOf("<section", headingAt);
  if (start < 0) throw new Error(`「${heading}」的 <section> 起点没找到`);

  // 配对计数，跳过嵌套 section
  let depth = 0;
  let pos = start;
  for (;;) {
    const open = html.indexOf("<section", pos);
    const close = html.indexOf("</section>", pos);
    if (close < 0) throw new Error(`「${heading}」没有闭合的 </section>`);
    if (open >= 0 && open < close) {
      depth += 1;
      pos = open + 9;
    } else {
      depth -= 1;
      pos = close + 10;
      if (depth === 0) return html.slice(start, pos).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    }
  }
}
