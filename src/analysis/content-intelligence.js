import { detectBrandMention } from "../brand/detect.js";

const PROFILE_VERSION = "content-profile-v1";

function decodeEntities(value) {
  return String(value ?? "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function stripTags(value) {
  return decodeEntities(String(value ?? "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function trimText(value, max = 1200) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function primaryContentHtml(html) {
  const source = String(html ?? "");
  for (const tag of ["article", "main"]) {
    const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(source);
    if (match?.[1] && stripTags(match[1]).length >= 240) return match[1];
  }
  return source;
}

function headingOutline(html) {
  const rows = [];
  for (const match of String(html ?? "").matchAll(/<(h[1-3])\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const text = trimText(stripTags(match[2]), 180);
    if (!text) continue;
    rows.push({ level: Number(match[1].slice(1)), text });
    if (rows.length >= 40) break;
  }
  return rows;
}

function paragraphCount(html) {
  let count = 0;
  for (const match of String(html ?? "").matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    if (stripTags(match[1]).length >= 20) count += 1;
  }
  return count;
}

function classifyContentProfile({ titleText, outline, tableCount, listCount, faqHeadingCount, schemaTypes }) {
  const title = String(titleText ?? "");
  const headings = outline.map((row) => row.text).join(" ");
  const text = `${title} ${headings}`;
  const lowerSchemas = new Set((schemaTypes ?? []).map((value) => String(value).toLowerCase()));

  let type = "informational";
  if (lowerSchemas.has("newsarticle") || /新闻|消息|发布|宣布|通报|快讯/.test(title)) type = "news";
  else if (/对比|比较|区别|差异|\bvs\b|哪个好|怎么选/.test(text)) type = "comparison";
  else if (/评测|测评|体验|怎么样|靠谱吗|值得吗/.test(text)) type = "review";
  else if (/如何|怎么|步骤|教程|指南|方法|操作/.test(text)) type = "how_to";
  else if (/推荐|排行|排名|榜单|盘点|哪家|哪里好|去哪/.test(text)) type = "recommendation_list";
  else if (faqHeadingCount >= 2 || lowerSchemas.has("faqpage")) type = "faq";

  const structure = [];
  if (outline.some((row) => row.level === 1)) structure.push("H1");
  if (outline.some((row) => row.level === 2)) structure.push("H2");
  if (outline.some((row) => row.level === 3)) structure.push("H3");
  if (tableCount > 0) structure.push("TABLE");
  if (listCount > 0) structure.push("LIST");
  if (faqHeadingCount > 0) structure.push("FAQ");

  return { version: PROFILE_VERSION, type, structure };
}

function brandContexts(text, detection, maxContexts = 5) {
  if (!detection?.mentioned) return [];
  const out = [];
  for (const item of detection.matchedTerms ?? []) {
    const position = Number(item.firstPosition);
    if (!Number.isFinite(position)) continue;
    const start = Math.max(0, position - 90);
    const end = Math.min(text.length, position + String(item.term ?? "").length + 110);
    const snippet = trimText(text.slice(start, end), 240);
    if (snippet && !out.some((row) => row.snippet === snippet)) {
      out.push({ term: item.term, kind: item.kind, snippet });
    }
    if (out.length >= maxContexts) break;
  }
  return out;
}

function brandLocationFlags({ titleText, metaDescription, outline, bodyText, brandRules }) {
  if (!brandRules?.terms?.length) return [];
  const locations = [];
  if (detectBrandMention(String(titleText ?? ""), brandRules).mentioned) locations.push("title");
  if (detectBrandMention(String(metaDescription ?? ""), brandRules).mentioned) locations.push("meta_description");
  const h1Text = outline.filter((row) => row.level === 1).map((row) => row.text).join(" ");
  const h2Text = outline.filter((row) => row.level === 2).map((row) => row.text).join(" ");
  const h3Text = outline.filter((row) => row.level === 3).map((row) => row.text).join(" ");
  if (detectBrandMention(h1Text, brandRules).mentioned) locations.push("h1");
  if (detectBrandMention(h2Text, brandRules).mentioned) locations.push("h2");
  if (detectBrandMention(h3Text, brandRules).mentioned) locations.push("h3");
  if (detectBrandMention(bodyText, brandRules).mentioned) locations.push("body");
  return locations;
}

/**
 * Derived intelligence for a cited/retrieved page. We intentionally keep only a short
 * readable excerpt, heading outline and small brand contexts; raw third-party HTML/full
 * article text is not persisted.
 */
export function buildPageContentIntelligence(html, {
  titleText = null,
  metaDescription = null,
  tableCount = 0,
  listCount = 0,
  faqHeadingCount = 0,
  schemaTypes = [],
  brandRules = null,
} = {}) {
  const primaryHtml = primaryContentHtml(html);
  const bodyText = stripTags(
    primaryHtml
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " "),
  );
  const outline = headingOutline(primaryHtml);
  const detection = brandRules?.terms?.length
    ? detectBrandMention(bodyText, brandRules)
    : {
        version: null,
        mentioned: false,
        mentionCount: 0,
        firstMentionPosition: null,
        matchedTerms: [],
        excludedMatchCount: 0,
      };

  return {
    contentExcerpt: trimText(bodyText, 1200),
    paragraphCount: paragraphCount(primaryHtml),
    outline,
    contentProfile: classifyContentProfile({
      titleText,
      outline,
      tableCount,
      listCount,
      faqHeadingCount,
      schemaTypes,
    }),
    brandMentioned: detection.mentioned,
    brandMentionCount: detection.mentionCount,
    brandFirstMentionPosition: detection.firstMentionPosition,
    brandMatchedTerms: detection.matchedTerms,
    brandContexts: brandContexts(bodyText, detection),
    brandLocations: brandLocationFlags({
      titleText,
      metaDescription,
      outline,
      bodyText,
      brandRules,
    }),
    brandDetectionVersion: detection.version,
    brandTermsUsed: (brandRules?.terms ?? []).map((row) => ({ term: row.term, kind: row.kind })),
  };
}
