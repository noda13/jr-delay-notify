export class LineRateLimitError extends Error {
  constructor() {
    super("LINE API rate limit exceeded — monthly quota may be exhausted");
    this.name = "LineRateLimitError";
  }
}

/** Sends a broadcast message to all LINE friends of the bot. */
export async function sendLineMessage(
  token: string,
  text: string,
): Promise<void> {
  const res = await fetch("https://api.line.me/v2/bot/message/broadcast", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messages: [
        {
          type: "text",
          text,
        },
      ],
    }),
  });

  if (!res.ok) {
    if (res.status === 429) {
      throw new LineRateLimitError();
    }
    const body = await res.text();
    const truncatedBody = body.length > 200 ? `${body.slice(0, 200)}…` : body;
    throw new Error(
      `LINE API error: ${res.status} ${res.statusText} — ${truncatedBody}`,
    );
  }
}
