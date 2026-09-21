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
                  data: {},
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
