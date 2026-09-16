export function apiKeyAuth(req, res, next) {
  const expected = process.env.ONEGL_API_KEY;
  if (!expected) {
    return res.status(503).json({ error: "ONEGL_API_KEY is not configured" });
  }
  const header = req.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const provided = match?.[1] || req.get("x-api-key") || "";
  if (!provided || provided !== expected) {
    return res.status(401).json({ error: "unauthorized" });
  }
  return next();
}
