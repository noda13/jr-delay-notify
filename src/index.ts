import { DEFAULT_TARGETS, STATUS, StoredState, WatchTarget } from "./config";
import { buildNotificationText } from "./message";
import { scrapeTarget } from "./scraper";
import { readState, shouldNotify, writeState } from "./state";
import { sendLineMessage } from "./line";

interface TargetResult {
  id: string;
  label: string;
  status: number;
  description: string;
  notified: boolean;
}

async function processTarget(
  target: WatchTarget,
  env: Env,
  notifyOnRecovery: boolean,
): Promise<TargetResult> {
  const result = await scrapeTarget(target);
  const previous = await readState(env.JR_STATE, target.id);
  const notify = shouldNotify(previous, result.status);

  let notified = false;
  let lineFailed = false;
  const sendWanted = notify && !(result.status === STATUS.NORMAL && !notifyOnRecovery);
  if (sendWanted) {
    const text = buildNotificationText(target, result.status, result.description, result.updatedAt);
    try {
      await sendLineMessage(env.LINE_CHANNEL_ACCESS_TOKEN, text);
      notified = true;
    } catch (lineErr) {
      console.error(`LINE notification failed for ${target.id}:`, lineErr);
      lineFailed = true;
    }
  }

  const newState: StoredState = {
    status: result.status,
    notifiedAt: notified ? new Date().toISOString() : (previous?.notifiedAt ?? ""),
    description: result.description,
    // Known limitation: a pending disruption alert (pendingNotify=true) is intentionally cleared
    // when the route recovers to NORMAL while NOTIFY_ON_RECOVERY is false. The disruption has
    // already resolved, so sending a late "was disrupted" alert would confuse users.
    pendingNotify: lineFailed || (previous?.pendingNotify === true && sendWanted && !notified),
  };
  try {
    await writeState(env.JR_STATE, target.id, newState);
  } catch (kvErr) {
    // State not persisted. If notification was sent (notified=true), the next poll may
    // detect the same transition again and send a duplicate — accepted at-least-once behavior.
    console.error(`KV write failed for ${target.id}:`, kvErr);
  }

  return { id: target.id, label: target.label, status: result.status, description: result.description, notified };
}

async function timingSafeStringEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode("jr-delay-notify-compare-key"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const [aSig, bSig] = await Promise.all([
    crypto.subtle.sign("HMAC", key, enc.encode(a)),
    crypto.subtle.sign("HMAC", key, enc.encode(b)),
  ]);
  const aBytes = new Uint8Array(aSig);
  const bBytes = new Uint8Array(bSig);
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
}

function isRecoveryEnabled(env: Env): boolean {
  const v = env.NOTIFY_ON_RECOVERY?.toLowerCase();
  return v !== "false" && v !== "0" && v !== "no";
}

export default {
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const notifyOnRecovery = isRecoveryEnabled(env);

    const settled = await Promise.allSettled(
      DEFAULT_TARGETS.map((target) => processTarget(target, env, notifyOnRecovery)),
    );

    const errorStateKey = "state:__error-active";
    const prevErrorRaw = await env.JR_STATE.get(errorStateKey).catch((e) => {
      console.error("Failed to read error-active state from KV (may cause duplicate error notification):", e);
      return null;
    });
    const wasInError = prevErrorRaw === "1";

    const failedTargets = settled
      .map((r, i) => ({ r, target: DEFAULT_TARGETS[i] }))
      .filter(({ r }) => r.status === "rejected");

    for (const { r, target } of failedTargets) {
      console.error(`Error processing target ${target.id}:`, (r as PromiseRejectedResult).reason);
    }

    if (failedTargets.length > 0) {
      // errorNotified: true if the user was already told (prior run) or we just told them
      let errorNotified = wasInError;
      if (!wasInError && env.LINE_CHANNEL_ACCESS_TOKEN) {
        const errorMsg =
          failedTargets.length === 1
            ? `🚨 【エラー】${failedTargets[0].target.label} の監視中にエラーが発生しました。詳細はログを確認してください。`
            : `🚨 【エラー】${failedTargets.length}件の監視でエラーが発生しました。詳細はログを確認してください。`;
        errorNotified = await sendLineMessage(env.LINE_CHANNEL_ACCESS_TOKEN, errorMsg)
          .then(() => true)
          .catch((e) => {
            console.error("Failed to send error notification to LINE:", e);
            return false;
          });
      }
      if (errorNotified) {
        await env.JR_STATE.put(errorStateKey, "1", { expirationTtl: 60 * 60 * 24 }).catch((e) => {
          console.error("Failed to persist error-active state to KV:", e);
        });
      }
    } else if (wasInError) {
      await env.JR_STATE.put(errorStateKey, "0", { expirationTtl: 60 * 60 * 24 }).catch((e) => {
        console.error("Failed to persist error-active state to KV:", e);
      });
    }
  },

  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/check") {
      if (!env.CHECK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      const provided = request.headers.get("X-Check-Secret");
      if (!provided || !(await timingSafeStringEqual(provided, env.CHECK_SECRET))) {
        return new Response("Forbidden", { status: 403 });
      }

      const notifyOnRecovery = isRecoveryEnabled(env);
      const settled = await Promise.allSettled(
        DEFAULT_TARGETS.map((target) => processTarget(target, env, notifyOnRecovery)),
      );

      const results: TargetResult[] = settled.map((r, i) => {
        if (r.status === "fulfilled") return r.value;
        console.error(`Error processing target ${DEFAULT_TARGETS[i].id}:`, r.reason);
        return {
          id: DEFAULT_TARGETS[i].id,
          label: DEFAULT_TARGETS[i].label,
          status: -1,
          description: "internal error",
          notified: false,
        };
      });

      return Response.json({ ok: true, results });
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(
        "jr-delay-notify worker is running.\nGET /check to trigger manually.",
        { headers: { "Content-Type": "text/plain; charset=utf-8" } },
      );
    }
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
