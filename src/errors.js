export const ErrorCode = Object.freeze({
  LOGIN_REQUIRED: "DOUBAO_LOGIN_REQUIRED",
  SESSION_EXPIRED: "DOUBAO_SESSION_EXPIRED",
  VERIFICATION_REQUIRED: "DOUBAO_VERIFICATION_REQUIRED",
  ACCESS_RESTRICTED: "DOUBAO_ACCESS_RESTRICTED",
  TIMEOUT: "DOUBAO_TIMEOUT",
  SUBMISSION_FAILED: "DOUBAO_SUBMISSION_FAILED",
  ANSWER_NOT_FOUND: "ANSWER_NOT_FOUND",
  CITATION_PARSE_FAILED: "CITATION_PARSE_FAILED",
  /**
   * 提问发出去了、答案也拿到了，但提交方式是回车而不是发送按钮。
   *
   * 回车提交不触发豆包渲染引用区：实测 13/13 全部 0 引用，而按钮提交 11–39 条。
   * 答案文本本身有效，但「0 引用」在这里是采集手段的产物，不是平台事实。
   * 记成 success 会把采集缺陷写进引用率统计，所以单独成一个错误码，
   * 让它走重试（重试通常就落到按钮上了），而不是污染数据。
   */
  SUBMIT_DEGRADED: "DOUBAO_SUBMIT_DEGRADED",
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
