export class LineRateLimitError extends Error {
  constructor() {
    super("LINE API rate limit exceeded — monthly quota may be exhausted");
    this.name = "LineRateLimitError";
  }
}

const BROADCAST_URL = "https://api.line.me/v2/bot/message/broadcast";
const PUSH_URL = "https://api.line.me/v2/bot/message/push";

/**
 * Sends a text message via LINE. With `to` (userId / groupId) uses the push API;
 * without it broadcasts to all friends of the bot.
 */
export async function sendLineMessage(
  token: string,
  text: string,
  to?: string,
): Promise<void> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(to ? PUSH_URL : BROADCAST_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...(to ? { to } : {}),
        messages: [
          {
            type: "text",
            text,
          },
        ],
      }),
      signal: controller.signal,
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
  } finally {
    clearTimeout(timeoutId);
  }
}
