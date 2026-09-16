export function serviceHealth(_req, res) {
  res.json({ service: "onegl", status: "ok" });
}
