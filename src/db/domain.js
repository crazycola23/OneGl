/**
 * Registrable-domain normalisation for citation aggregation.
 *
 * `domain` keeps the hostname exactly as observed (m.toutiao.com), while
 * `normalized_domain` is what domain-level counts aggregate on (toutiao.com).
 *
 * This is a deliberately small heuristic, not a full public suffix list: it keeps the
 * dependency surface at zero and covers the second-level suffixes seen in Doubao
 * citation data. Anything it does not recognise falls back to the last two labels,
 * which is the correct answer for every plain .com / .cn / .org host.
 */
const MULTI_PART_SUFFIXES = new Set([
  "com.cn",
  "net.cn",
  "org.cn",
  "gov.cn",
  "edu.cn",
  "ac.cn",
  "com.hk",
  "org.hk",
  "net.hk",
  "edu.hk",
  "gov.hk",
  "com.tw",
  "org.tw",
  "net.tw",
  "edu.tw",
  "gov.tw",
  "co.jp",
  "or.jp",
  "ne.jp",
  "ac.jp",
  "go.jp",
  "co.kr",
  "or.kr",
  "ne.kr",
  "go.kr",
  "co.uk",
  "org.uk",
  "me.uk",
  "ac.uk",
  "gov.uk",
  "com.au",
  "net.au",
  "org.au",
  "edu.au",
  "gov.au",
  "com.sg",
  "com.my",
  "com.br",
  "com.mx",
  "com.tr",
  "co.in",
]);

export function normalizeDomain(hostname) {
  if (!hostname) return null;
  const host = String(hostname).toLowerCase().replace(/\.$/, "");
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return host;

  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_PART_SUFFIXES.has(lastTwo) && labels.length >= 3) {
    return labels.slice(-3).join(".");
  }
  return lastTwo;
}
