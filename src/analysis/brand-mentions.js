import { compileBrandRules, detectBrandMention } from "../brand/detect.js";
import { safeContext, isUsableAnswerText, MIN_USABLE_ANSWER_CHARS } from "./text-slice.js";

/**
 * 品牌提及对比。
 *
 * ## 分工：品牌由调用方给，OneGl 只做匹配统计
 *
 * 早期版本试过「从回答里猜机构名」（靠后缀词表召回 + 噪音过滤 + 归并），
 * 两条路都走不通：
 *   - 后缀词表换行业就失效，而用户不会为了跑 GEO 去维护这张表
 *   - 「哪两个写法指同一家」「这次提及是推荐还是顺带一提」都是语义问题，规则做不了
 *
 * 所以改成：**调用方用模型（或人工）从候选块里挑出品牌，传进来，OneGl 只匹配。**
 * 匹配用 src/brand/detect.js 既有的规则检测，纯子串 + 重叠消解，零维护成本。
 *
 * 这样做还有个好处：结果可复现。同样的品牌列表跑两次，数字完全一样；
 * 而「模型每次读原文给个排名」不可复现，也无法核对。
 */

const MAX_BRANDS = 50;
const MAX_ALIASES = 20;
const MAX_EXAMPLES = 3;

export class BrandInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "BrandInputError";
  }
}

function cleanList(value, name, { max, itemMax = 200 }) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new BrandInputError(`${name} must be an array`);
  const out = [];
  for (const item of value) {
    if (item == null) continue;
    const text = String(item).trim();
    if (!text) continue;
    if (text.length > itemMax) throw new BrandInputError(`${name} entries must be at most ${itemMax} characters`);
    if (out.includes(text)) continue;
    out.push(text);
    if (out.length > max) throw new BrandInputError(`${name} must contain at most ${max} entries`);
  }
  return out;
}

/**
 * 预编译校验 exclude_patterns。
 *
 * 与 src/brand/detect.js 的 validateExcludePattern 同规则：拒绝嵌套无界量词
 * （`(a+)+` 这类灾难性回溯形态），其余交给 RegExp 编译。目的是在任何昂贵工作
 * 之前把非法输入挡下来，并给出 422 而不是 500。
 */
function validateExcludePattern(source, brandIndex) {
  try {
    // eslint-disable-next-line no-new
    new RegExp(source, "giu");
  } catch (error) {
    throw new BrandInputError(
      `brands[${brandIndex}].exclude_patterns contains an invalid regular expression: ${error.message}`,
    );
  }
  if (/\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*(?:[*+]|\{\d*,?\d*\})/.test(source)) {
    throw new BrandInputError(
      `brands[${brandIndex}].exclude_patterns contains nested unbounded quantifiers: ${JSON.stringify(source)}`,
    );
  }
}

/**
 * 校验并归一化调用方传入的品牌列表。
 *
 * 刻意**不**要求 name 出现在 aliases 里 —— detect.js 的 compileBrandRules
 * 会自动把 name 加进别名集，这里保持一致，避免调用方以为必须写两遍。
 */
export function normalizeBrands(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new BrandInputError("brands must be an array");
  if (input.length > MAX_BRANDS) {
    throw new BrandInputError(`brands must contain at most ${MAX_BRANDS} entries`);
  }

  const seen = new Set();
  return input.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new BrandInputError(`brands[${index}] must be an object`);
    }
    const name = String(raw.name ?? "").trim();
    if (!name) throw new BrandInputError(`brands[${index}].name is required`);
    if (name.length > 200) throw new BrandInputError(`brands[${index}].name is too long`);
    if (seen.has(name)) throw new BrandInputError(`duplicate brand name: ${name}`);
    seen.add(name);

    // exclude_patterns 是正则，出于和 detect.js 一致的安全考虑限制长度
    const excludePatterns = cleanList(raw.exclude_patterns ?? raw.excludePatterns, `brands[${index}].exclude_patterns`, {
      max: MAX_ALIASES,
      itemMax: 200,
    });
    // 在归一化阶段就编译一次，非法正则立刻变成 422。
    //
    // 之前只在这里限制长度，正则本身留到 computeBrandMentions → compileBrandRules
    // 才编译，那里抛的是**普通 Error**；调用方只捕获 BrandInputError，
    // 于是 `exclude_patterns: ["("]` 这种输入会一路冒到最外层变成 **500** ——
    // 而它是纯粹的请求参数问题，重试永远不会成功。
    for (const pattern of excludePatterns) validateExcludePattern(pattern, index);

    return {
      name,
      aliases: cleanList(raw.aliases ?? raw.alias, `brands[${index}].aliases`, { max: MAX_ALIASES }),
      product_aliases: cleanList(
        raw.product_aliases ?? raw.productAliases,
        `brands[${index}].product_aliases`,
        { max: MAX_ALIASES },
      ),
      exclude_patterns: excludePatterns,
      // 调用方可以标注这是自己的品牌还是竞品，报告里原样透出，便于分组展示。
      role: raw.role === "competitor" ? "competitor" : raw.role === "own" ? "own" : "unspecified",
    };
  });
}

/**
 * 对一批回答计算每个品牌的提及情况。
 *
 * 口径全部可复现、可核对：
 *   mentioned_answers  提及该品牌的回答数（分母是该平台有正文的回答数）
 *   mention_rate       提及率 = mentioned_answers / valid_answers
 *   mention_count      总提及次数（同一回答里多次出现会累加）
 *   first_position_avg 首次出现位置均值（0 表示 AI 在开头就提，用来判断是「重点推荐」
 *                      还是「顺带列举」—— 数值越小越靠前）
 *   examples           原文片段，可回溯核对
 */
/**
 * 一段回答是否值得进入提及率的分母。
 *
 * 判定规则（阈值与理由）见 text-slice.js 的 MIN_USABLE_ANSWER_CHARS ——
 * 刻意不只判空：平台在检索过程中会短暂把 UI 文案当成回答内容，
 * 采集器如实记下后 `status` 仍是 success、正文也非空。实测豆包侧就有
 * 4 条「找到 1 篇资料」「找到 10 篇资料」这种 8–9 字的检索中间态，
 * 它们不是 AI 的回答，却会实打实地压低分母、稀释提及率。
 *
 * 与 answer-sample.js 共用同一阈值：抽样喂给模型的样本集与统计分母
 * 必须是同一批回答，否则会出现「模型读到废答案、统计却没算」的错位。
 */
export function computeBrandMentions(answers, brands, { exampleRadius = 90, maxExamples = MAX_EXAMPLES } = {}) {
  const valid = answers.filter((answer) => isUsableAnswerText(answer?.text));
  // 明确告知有多少条被排除：分母变了，调用方必须能查证
  const excluded = answers.length - valid.length;
  const compiled = brands.map((brand) => ({
    brand,
    rules: compileBrandRules({
      name: brand.name,
      aliases: brand.aliases,
      productAliases: brand.product_aliases,
      excludePatterns: brand.exclude_patterns,
    }),
  }));

  const stats = compiled.map(({ brand, rules }) => {
    const entry = {
      name: brand.name,
      role: brand.role,
      aliases: brand.aliases,
      product_aliases: brand.product_aliases,
      // 实际参与匹配的词表：name 由 compileBrandRules 自动并入别名
      match_terms: rules.terms.map((term) => term.term),
      mentioned_answers: 0,
      mention_count: 0,
      first_position_total: 0,
      first_position_count: 0,
      answers: new Set(),
      providers: new Set(),
      byProvider: new Map(),
      examples: [],
    };
    for (const answer of valid) {
      const hit = detectBrandMention(answer.text, rules);
      const bucket = entry.byProvider.get(answer.provider) ?? {
        valid_answers: 0, mentioned_answers: 0, mention_count: 0,
      };
      bucket.valid_answers += 1;
      if (hit.mentioned === true) {
        entry.mentioned_answers += 1;
        entry.mention_count += hit.mentionCount;
        entry.answers.add(answer.runId);
        entry.providers.add(answer.provider);
        bucket.mentioned_answers += 1;
        bucket.mention_count += hit.mentionCount;
        if (hit.firstMentionPosition != null) {
          entry.first_position_total += hit.firstMentionPosition;
          entry.first_position_count += 1;
        }
        if (entry.examples.length < maxExamples) {
          const at = hit.firstMentionPosition ?? 0;
          const text = String(answer.text);
          entry.examples.push({
            run_id: answer.runId,
            provider: answer.provider,
            position: at,
            matched_terms: hit.matchedTerms.map((term) => term.term),
            context: safeContext(text, at, 0, exampleRadius),
          });
        }
      }
      entry.byProvider.set(answer.provider, bucket);
    }
    return entry;
  });

  const rows = stats.map((entry) => {
    const totalValid = valid.length;
    const byPlatform = {};
    for (const [provider, bucket] of entry.byProvider) {
      byPlatform[provider] = {
        valid_answers: bucket.valid_answers,
        mentioned_answers: bucket.mentioned_answers,
        mention_rate: bucket.valid_answers ? bucket.mentioned_answers / bucket.valid_answers : null,
        mention_count: bucket.mention_count,
      };
    }
    return {
      name: entry.name,
      role: entry.role,
      match_terms: entry.match_terms,
      valid_answers: totalValid,
      mentioned_answers: entry.mentioned_answers,
      mention_rate: totalValid ? entry.mentioned_answers / totalValid : null,
      mention_count: entry.mention_count,
      platform_count: entry.providers.size,
      platforms: [...entry.providers].sort(),
      // 首次出现位置的均值：越小说明 AI 越早提到它。
      // 这是「重点推荐」与「顺带列举」的粗略信号，不能替代阅读原文判断。
      average_first_position:
        entry.first_position_count > 0 ? entry.first_position_total / entry.first_position_count : null,
      by_platform: byPlatform,
      examples: entry.examples,
    };
  });

  rows.sort(
    (a, b) =>
      (b.mention_rate ?? 0) - (a.mention_rate ?? 0) ||
      b.mention_count - a.mention_count ||
      a.name.localeCompare(b.name, "zh"),
  );

  return {
    schema: "brand-mentions.v1",
    answer_count: valid.length,
    // 分母被排除的条数。平台检索中间态（如「找到 1 篇资料」）和抓取残片
    // 会实打实稀释提及率，必须让调用方看得见排除了多少。
    excluded_answers: excluded,
    brand_count: rows.length,
    // 按 mention_rate 降序；同率按总提及次数。再同则按名称。
    basis: "mentioned_answers_over_valid_answers",
    brands: rows,
    interpretation: {
      provided_by: "onegl",
      role: "mention_statistics",
      conclusion: null,
      guidance:
        "这是可复现的提及率统计：分母是该平台**有效**回答数（正文非空且不短于 " +
        `${MIN_USABLE_ANSWER_CHARS} 字，以排除平台检索中间态与抓取残片），分子是提及该品牌的回答数。` +
        `本次排除了 ${excluded} 条过短回答。` +
        "match_terms 是实际参与匹配的词表，请确认它符合预期 —— 少写别名会漏匹配。" +
        "「被提及」不等于「被推荐」：判断推荐强度、渠道差异、以及如何应对，" +
        "请结合 examples.context 与排名用你自己的模型分析。",
    },
  };
}

export const brandMentionConstants = { MAX_BRANDS, MAX_ALIASES, MAX_EXAMPLES };
