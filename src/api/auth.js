import { timingSafeEqual } from "node:crypto";

function headerValue(headers, name) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? "";
  return value == null ? "" : String(value);
}

export function apiCredentialFromHeaders(headers = {}) {
  const authorization = headerValue(headers, "authorization");
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim();
  if (bearer) return bearer;
  return headerValue(headers, "x-api-key").trim();
}

export function secureStringEqual(left, right) {
  const a = Buffer.from(String(left ?? ""), "utf8");
  const b = Buffer.from(String(right ?? ""), "utf8");
  if (!a.length || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function isApiRequestAuthorized(req, expected = process.env.ONEGL_API_KEY) {
  if (!expected) return false;
  return secureStringEqual(apiCredentialFromHeaders(req.headers), expected);
}
