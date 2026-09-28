/**
 * Rule-based brand mention detection.
 *
 * This is deliberately the first stage: aliases and exclude patterns are explicit and
 * auditable, and the raw answer is always kept so a human can check any verdict. An
 * LLM judge can be layered on later without changing the stored shape.
 *
 * `position` values are 0-based UTF-16 offsets into the original answer string.
 */

export const BRAND_DETECTION_VERSION = "rules-v2";

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toTermList(values) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function regexForTerm(term) {
  const escaped = escapeRegExp(term);
  // CJK aliases intentionally keep substring semantics. For aliases that contain ASCII
  // word characters, require ASCII token boundaries so short aliases such as "AI" do
  // not silently match inside "OpenAI", while mixed strings such as "小米SU7" still
  // match naturally next to Chinese text.
  if (!/[A-Za-z0-9]/.test(term)) return new RegExp(escaped, "giu");
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "giu");
}

/**
 * 拒绝会在长文本上爆炸的正则。
 *
 * ## 为什么不用「检测灾难性回溯形态」这条路
 *
 * 早期版本只挡了一种形态：带括号的无界量词嵌套（`(a+)+`、`(.*)*`）。
 * 实测这个判据有致命缺口 —— `a*a*a*a*a*a*a*a*a*a*b` 这种**没有括号**的
 * 相邻无界量词构成多项式回溯，完全绕过检查，而 `new RegExp` 正常编译。
 * 代价：40 字符的回答文本，单次 exec 耗时 242 秒。
 *
 * 而 detectBrandMention 是对「每条回答 × 每个品牌」循环调用的，
 * 也就是说单个 HTTP 请求就能把 Node 事件循环占住数分钟，
 * 期间整个 API 进程不响应任何其它租户。限流按请求数计，挡不住。
 *
 * ## 现在的做法：数结构特征，不猜形态
 *
 * 灾难性回溯的成因是「同一个位置有多种切分方式」，表现为两类：
 *   1. 嵌套无界量词（指数级）：`(a+)+`、`(a|a?)+`
 *   2. 大量相邻/嵌套的无界量词（多项式级）：`a*a*a*...*b`
 *
 * 与其枚举形态，不如直接约束「能制造多少种切分的结构」：
 *   - 不允许量词内部再含量词（嵌套）
 *   - 不允许量词内部含分支（`(a|aa)+` 同样是多项式回溯）
 *   - 无界量词总数封顶（相邻量词的次数决定多项式次数）
 *
 * 仍不是完备证明（语言本身难以静态判定），但把可利用的攻击面收敛到
 * 「3 个以内无界量词且无嵌套无分支」，这个上限下最坏情况是线性或低次多项式。
 */

/** 无界量词（`*` `+` `{n,}`）总数上限。3 个是「能表达真实排除规则」与「不会爆炸」之间的折中。 */
const MAX_UNBOUNDED_QUANTIFIERS = 3;
/** 有界量词 `{n,m}` 允许的最大展开规模：`{1,1000}` 之类也足以致命。 */
const MAX_BOUNDED_EXPANSION = 1000;

export function validateExcludePattern(source) {
  const pattern = String(source ?? "");

  if (pattern.length > 200) {
    throw new Error(`Brand exclude pattern is too long (${pattern.length} > 200)`);
  }

  // 1) 量词内部含量词或分支：`(a+)+`、`(a|aa)+`、`(a?)*` 都能造指数级切分
  if (/\((?:[^()\\]|\\.)*(?:[+*?]|\{\d+,?\d*\})(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,?\d*\})/.test(pattern)) {
    throw new Error(`Brand exclude pattern nests a quantifier inside a quantified group: ${JSON.stringify(source)}`);
  }
  // `(a|aa)+` / `(a|a?)+`：分支里的两个分支能匹配同一段文本
  if (/\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,?\d*\})/.test(pattern)) {
    throw new Error(`Brand exclude pattern quantifies a group with alternation: ${JSON.stringify(source)}`);
  }

  // 2) 无界量词总数封顶：相邻量词个数就是多项式回溯的次数
  //
  // 计数要排除被反斜杠转义的（`a\*` 是字面星号不是量词）。用逐字符扫描而不是
  // 正则：`/[+*]/g` 会把 `\*` 也数进去，而带负向后行断言的版本在 alternation
  // 里会漏掉最后一个量词（实测 `a+a+a+a` 只数到 3 个）。
  let unbounded = 0;
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern[i] === "\\") { i += 1; continue; } // 跳过被转义的下一个字符
    if (pattern[i] === "*" || pattern[i] === "+") unbounded += 1;
    else if (pattern[i] === "{" && /^\{\d+,\}/.test(pattern.slice(i))) unbounded += 1;
  }
  if (unbounded > MAX_UNBOUNDED_QUANTIFIERS) {
    throw new Error(
      `Brand exclude pattern has ${unbounded} unbounded quantifiers ` +
        `(max ${MAX_UNBOUNDED_QUANTIFIERS}); adjacent quantifiers cause polynomial backtracking`,
    );
  }

  // 3) 反向引用与前瞻：这些结构常与量词组合出高代价回溯，且排除规则用不到
  if (/(?<!\\)\\[1-9]/.test(pattern)) {
    throw new Error(`Brand exclude pattern uses a backreference: ${JSON.stringify(source)}`);
  }

  // 4) 有界量词展开规模封顶：`a{1,1000}` 在长文本上同样致命
  for (const m of pattern.matchAll(/(?<!\\)\{(\d+),(\d+)\}/g)) {
    const [, low, high] = m.map(Number);
    if (high - low > MAX_BOUNDED_EXPANSION) {
      throw new Error(
        `Brand exclude pattern expands to ${high - low} repetitions (max ${MAX_BOUNDED_EXPANSION})`,
      );
    }
  }

  // 5) 兜底：必须能编译（非法正则不该留到运行期才炸）
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern, "giu");
  } catch (error) {
    throw new Error(`Brand exclude pattern is not a valid regular expression: ${error.message}`);
  }
}

export function compileBrandRules(brand = {}) {
  const name = String(brand.name ?? "").trim();
  const aliasTerms = toTermList([...(brand.aliases ?? []), name]);
  const productTerms = toTermList(brand.productAliases ?? []).filter(
    (term) => !aliasTerms.includes(term),
  );

  const terms = [
    ...aliasTerms.map((term) => ({ term, kind: "brand" })),
    ...productTerms.map((term) => ({ term, kind: "product" })),
  ].map((entry) => ({
    ...entry,
    regex: regexForTerm(entry.term),
  }));

  // Exclude patterns are regular expressions supplied by the operator, used to blank
  // out contexts where an alias means something else (for example a phone brand).
  const excludes = toTermList(brand.excludePatterns ?? []).map((source) => {
    validateExcludePattern(source);
    try {
      return { source, regex: new RegExp(source, "giu") };
    } catch (error) {
      throw new Error(`Invalid brand exclude pattern ${JSON.stringify(source)}: ${error.message}`);
    }
  });

  return { name, terms, excludes };
}

function collectSpans(text, regexes) {
  const spans = [];
  for (const { regex } of regexes) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
      if (match[0].length === 0) {
        regex.lastIndex += 1;
        continue;
      }
      spans.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return spans;
}

// Replace excluded spans with spaces of equal length so offsets in the masked text
// still line up with the original answer.
function maskSpans(text, spans) {
  if (!spans.length) return text;
  const ordered = [...spans].sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const span of ordered) {
    if (span.start < cursor) continue;
    out += text.slice(cursor, span.start) + " ".repeat(span.end - span.start);
    cursor = span.end;
  }
  return out + text.slice(cursor);
}

// Overlapping matches would double count: "小米SU7" must not count once as "小米SU7"
// and again as "SU7". Prefer the longest match at each position.
function resolveOverlaps(matches) {
  const ordered = [...matches].sort(
    (a, b) => a.position - b.position || b.length - a.length || a.term.localeCompare(b.term),
  );
  const kept = [];
  let lastEnd = -1;
  for (const match of ordered) {
    if (match.position < lastEnd) continue;
    kept.push(match);
    lastEnd = match.position + match.length;
  }
  return kept;
}

export function detectBrandMention(answer, rules) {
  const text = typeof answer === "string" ? answer : "";
  if (!text || !rules.terms.length) {
    return {
      version: BRAND_DETECTION_VERSION,
      mentioned: false,
      mentionCount: 0,
      firstMentionPosition: null,
      matchedTerms: [],
      excludedMatchCount: 0,
    };
  }

  const excludedSpans = collectSpans(text, rules.excludes);
  const masked = maskSpans(text, excludedSpans);

  const rawMatches = [];
  for (const { term, kind, regex } of rules.terms) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(masked)) !== null) {
      if (match[0].length === 0) {
        regex.lastIndex += 1;
        continue;
      }
      rawMatches.push({
        term,
        kind,
        position: match.index,
        length: match[0].length,
      });
    }
  }

  const matches = resolveOverlaps(rawMatches);

  const byTerm = new Map();
  for (const match of matches) {
    const entry = byTerm.get(match.term) ?? {
      term: match.term,
      kind: match.kind,
      count: 0,
      firstPosition: match.position,
    };
    entry.count += 1;
    entry.firstPosition = Math.min(entry.firstPosition, match.position);
    byTerm.set(match.term, entry);
  }

  const ordered = [...matches].sort((a, b) => a.position - b.position);

  return {
    version: BRAND_DETECTION_VERSION,
    mentioned: matches.length > 0,
    mentionCount: matches.length,
    firstMentionPosition: ordered.length ? ordered[0].position : null,
    matchedTerms: [...byTerm.values()].sort(
      (a, b) => a.firstPosition - b.firstPosition || a.term.localeCompare(b.term),
    ),
    excludedMatchCount: excludedSpans.length,
  };
}
