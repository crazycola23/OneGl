const EVENT_TYPES = [
  "execution.completed",
  "execution.partial",
  "execution.failed",
  "execution.cancelled",
  "report.revision.ready",
  "account.action_required",
  "account.ready",
];

function pascal(value) {
  return String(value)
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/**
 * Mirrors what the producers actually write into the event payload: `data` stays an open
 * object in the schema, so an example is the only place the machine-readable contract tells a
 * consumer that an execution event names its platform and observation surfaces.
 */
function exampleData(eventType) {
  if (eventType.startsWith("execution.")) {
    return {
      task_id: "tsk_0123456789abcdef0123456789abcdef",
      execution_id: "exe_0123456789abcdef0123456789abcdef",
      report_id: "rpt_0123456789abcdef0123456789abcdef",
      platform: "doubao",
      status: eventType.slice("execution.".length),
      progress: { total: 20, completed: 20, failed: 0, skipped: 0 },
      login_states: ["account"],
      finished_at: "2026-09-17T00:00:00.000Z",
    };
  }
  if (eventType === "account.action_required") {
    return {
      provider: "qianwen",
      account_id: "qianwen-main",
      status: "session_expired",
      reason: "session_expired",
      cooldown_until: null,
      last_error_code: "session_expired",
    };
  }
  if (eventType === "account.ready") {
    return { provider: "qianwen", account_id: "qianwen-main", status: "ready" };
  }
  return {};
}

function receiver(eventType) {
  return {
    post: {
      operationId: `receive${pascal(eventType)}Webhook`,
      tags: ["Webhooks"],
      summary: `Receive ${eventType} webhook`,
      description:
        "Receiver-side contract for OneGl SaaS webhooks. Verify X-OneGl-Signature as HMAC-SHA256 over `<X-OneGl-Timestamp>.<raw request body>` using the endpoint signing secret, reject stale timestamps, and deduplicate by X-OneGl-Event-Id before applying side effects.",
      parameters: [
        {
          name: "X-OneGl-Event",
          in: "header",
          required: true,
          schema: { type: "string", const: eventType },
          description: "Public event type delivered by OneGl.",
        },
        {
          name: "X-OneGl-Event-Id",
          in: "header",
          required: true,
          schema: { type: "string", pattern: "^evt_[a-f0-9]{32}$" },
          description: "Stable public event ID used for consumer deduplication.",
        },
        {
          name: "X-OneGl-Webhook-Version",
          in: "header",
          required: true,
          schema: { type: "string", const: "1" },
          description: "Webhook envelope/signature version.",
        },
        {
          name: "X-OneGl-Timestamp",
          in: "header",
          required: true,
          schema: { type: "string", pattern: "^[0-9]+$" },
          description: "Unix timestamp in seconds used as the first signature input segment.",
        },
        {
          name: "X-OneGl-Signature",
          in: "header",
          required: true,
          schema: { type: "string", pattern: "^v1=[a-f0-9]{64}$" },
          description: "`v1=` followed by the lowercase hexadecimal HMAC-SHA256 digest.",
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/SaasWebhookEvent" },
            examples: {
              event: {
                value: {
                  id: "evt_0123456789abcdef0123456789abcdef",
                  type: eventType,
                  occurred_at: "2026-09-17T00:00:00.000Z",
                  created_at: "2026-09-17T00:00:00.000Z",
                  data: exampleData(eventType),
                },
              },
            },
          },
        },
      },
      responses: {
        200: { description: "Event accepted" },
        204: { description: "Event accepted with no response body" },
      },
    },
  };
}

export function applyWebhookContractOpenApi(document) {
  document.webhooks = Object.fromEntries(EVENT_TYPES.map((eventType) => [eventType, receiver(eventType)]));
  return document;
}
