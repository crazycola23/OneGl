export function asyncHandler(handler) {
  return function wrapped(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function apiErrorHandler(error, _req, res, _next) {
  const status = Number(error?.statusCode || error?.status || 500);
  res.status(status >= 400 && status < 600 ? status : 500).json({
    error: status >= 500 ? "internal_error" : error.message,
    details: process.env.NODE_ENV === "production" ? undefined : error.message,
  });
}
