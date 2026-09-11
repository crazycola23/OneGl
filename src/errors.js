export const ErrorCode = Object.freeze({
  LOGIN_REQUIRED: "DOUBAO_LOGIN_REQUIRED",
  SESSION_EXPIRED: "DOUBAO_SESSION_EXPIRED",
  VERIFICATION_REQUIRED: "DOUBAO_VERIFICATION_REQUIRED",
  ACCESS_RESTRICTED: "DOUBAO_ACCESS_RESTRICTED",
  TIMEOUT: "DOUBAO_TIMEOUT",
  SUBMISSION_FAILED: "DOUBAO_SUBMISSION_FAILED",
  ANSWER_NOT_FOUND: "ANSWER_NOT_FOUND",
  CITATION_PARSE_FAILED: "CITATION_PARSE_FAILED",
  // Raised before submit: the run refused to ask the prompt because a fresh, empty
  // conversation could not be confirmed. See executeDoubaoPrompt.
  CONVERSATION_RESET_FAILED: "DOUBAO_CONVERSATION_RESET_FAILED",
  PAGE_CHANGED: "PAGE_CHANGED",
  RATE_LIMITED: "RATE_LIMITED",
  NETWORK_ERROR: "NETWORK_ERROR",
  UNKNOWN_ERROR: "UNKNOWN_ERROR",
});

export class DoubaoMvpError extends Error {
  constructor(code, message, details = null, options = undefined) {
    super(message, options);
    this.name = "DoubaoMvpError";
    this.code = code;
    this.details = details;
  }
}

export function normalizeError(error) {
  if (error instanceof DoubaoMvpError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details ?? null,
    };
  }

  return {
    code: ErrorCode.UNKNOWN_ERROR,
    message: error instanceof Error ? error.message : String(error),
    details: null,
  };
}

export const SESSION_BLOCKING_CODES = new Set([
  ErrorCode.LOGIN_REQUIRED,
  ErrorCode.SESSION_EXPIRED,
  ErrorCode.VERIFICATION_REQUIRED,
  ErrorCode.ACCESS_RESTRICTED,
]);
