/** Parse source attributes observed in the saved Zhipu answer DOM. */
export function parseReferenceItems(items) {
  const citations = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const raw = typeof item?.url === "string" ? item.url.trim() : "";
    let link;
    try {
      link = new URL(raw);
    } catch {
      continue;
    }
    if (!["https:", "http:"].includes(link.protocol) || link.username || link.password) continue;
    // The same article appears at multiple inline markers; articles on the same host remain distinct.
    if (seen.has(link.href)) continue;
    seen.add(link.href);
    citations.push({
      url: raw,
      title: null,
      domain: link.hostname,
      sourceType: "visible",
      capturedFrom: "角标来源链接",
      citationMarker: null,
    });
  }
  return citations;
}
