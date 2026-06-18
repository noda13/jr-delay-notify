import { DEFAULT_TARGETS, RouteStatus, STATUS, StoredState, WatchTarget } from "./config";
import { buildNotificationText } from "./message";
import { scrapeTarget } from "./scraper";
import { readState, shouldNotify, writeState } from "./state";
import { LineRateLimitError, sendLineMessage } from "./line";

interface TargetResult {
  id: string;
  label: string;
  status: RouteStatus | -1;
  description: string;
  notified: boolean;
}

// scrapeTarget (fetch non-2xx, JSON parse, unknown senkuKey) and readState (KV.get) can throw.
// Those errors propagate as rejected promises to Promise.allSettled in the callers.
// LINE send and KV write errors are caught internally and do NOT cause rejection.
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
    if (!env.LINE_CHANNEL_ACCESS_TOKEN) {
      console.error(`[jr-delay-notify] LINE_CHANNEL_ACCESS_TOKEN is absent — notification skipped for ${target.id}. Check wrangler secrets.`);
      // Note: lineFailed is NOT set here — a missing token is a misconfiguration, not a transient
      // network failure, so retrying via pendingNotify=true would just spam the log.
    } else {
      const text = buildNotificationText(target, result.status, result.description, result.updatedAt);
      try {
        await sendLineMessage(env.LINE_CHANNEL_ACCESS_TOKEN, text);
        notified = true;
      } catch (lineErr) {
        if (lineErr instanceof LineRateLimitError) {
          // Set lineFailed so pendingNotify=true is stored — ensures the notification is
          // retried on the next run rather than permanently dropped. If the monthly quota
          // is exhausted, subsequent retries will also return 429 until quota resets.
          console.error(`LINE rate limit for ${target.id}: will retry on next run.`);
          lineFailed = true;
        } else {
          console.error(`LINE notification failed for ${target.id}:`, lineErr);
          lineFailed = true;
        }
      }
    }
  }

  const newState: StoredState = {
    status: result.status,
    ...(notified ? { notifiedAt: new Date().toISOString() } : (result.status === STATUS.DISRUPTED && previous?.notifiedAt) ? { notifiedAt: previous.notifiedAt } : {}),
    description: result.description,
    // pendingNotify=true when the LINE send failed (lineFailed=true), so the notification is retried
    // on the next run rather than permanently dropped.
    pendingNotify: lineFailed,
  };
  // Skip KV write when state is identical to previous to conserve free-tier write quota.
  // Compare all fields; treat undefined pendingNotify/notifiedAt as their false/absent equivalents.
  const stateChanged = previous === null
    || previous.status !== newState.status
    || previous.description !== newState.description
    || previous.notifiedAt !== newState.notifiedAt
    || (previous.pendingNotify ?? false) !== (newState.pendingNotify ?? false);
  if (stateChanged) {
    try {
      await writeState(env.JR_STATE, target.id, newState);
    } catch (kvErr) {
      // State not persisted. If notification was sent (notified=true), the next poll may
      // detect the same transition again and send a duplicate — accepted at-least-once behavior.
      // If LINE also failed (lineFailed=true), the pending retry flag may be lost if the
      // old KV state does not already have pendingNotify=true.
      console.error(`KV write failed for ${target.id} (lineFailed=${lineFailed}):`, kvErr);
    }
  }

  return { id: target.id, label: target.label, status: result.status, description: result.description, notified };
}

async function timingSafeStringEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    crypto.getRandomValues(new Uint8Array(32)),
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
    let prevErrorRaw: string | null = null;
    let errorReadFailed = false;
    try {
      prevErrorRaw = await env.JR_STATE.get(errorStateKey);
    } catch (e) {
      console.error("Failed to read error-active state from KV (may cause duplicate error notification):", e);
      errorReadFailed = true;
    }
    const wasInError = prevErrorRaw === "1";

    const failedTargets = settled
      .map((r, i) => ({ r, target: DEFAULT_TARGETS[i] }))
      .filter(({ r }) => r.status === "rejected");

    for (const { r, target } of failedTargets) {
      console.error(`Error processing target ${target.id}:`, (r as PromiseRejectedResult).reason);
    }

    // Note: failedTargets counts only processTarget rejections (scrapeTarget/readState throws).
    // LINE send and KV write failures are caught inside processTarget and do NOT appear here.
    // This is intentional: monitoring alerts cover hard scraper/network failures only.
    if (failedTargets.length > 0) {
      // One-shot alert: only send on the first failing run (!wasInError).
      // On subsequent failing runs wasInError=true — no re-alert is sent. If errors persist beyond
      // 7 days the flag expires naturally, and the next failing run sends a fresh alert (re-alert).
      let errorNotified = false;
      if (!wasInError && !errorReadFailed) {
        if (!env.LINE_CHANNEL_ACCESS_TOKEN) {
          console.error(`[jr-delay-notify] ${failedTargets.length} target(s) failed but LINE_CHANNEL_ACCESS_TOKEN is absent — alert suppressed.`);
        } else {
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
      }
      if (errorNotified) {
        // Set flag only on first detection. Not refreshed on subsequent failing runs, so the flag
        // ages out after 7 days if the error persists — producing a re-alert at that point.
        // Note: concurrent invocations may both read wasInError=false and both send — accepted
        // at-least-once edge case (no CAS in KV).
        // Note: if put fails below, next failing run (wasInError=false again) re-sends the alert
        // (at-least-once delivery, consistent with per-target KV write failure behavior).
        await env.JR_STATE.put(errorStateKey, "1", { expirationTtl: 60 * 60 * 24 * 7 }).catch((e) => {
          console.error("Failed to persist error-active state to KV:", e);
        });
      }
    } else if (wasInError) {
      // Clear "1" on recovery. Delete is preferred over put("0") to avoid
      // unnecessary KV writes on every recovery cycle.
      // Note: if KV.get threw (errorReadFailed=true), wasInError is forced false so this branch
      // does not fire. A stale "1" flag set by a prior run will remain until the next healthy run
      // (where wasInError=true and failedTargets=[] correctly triggers this delete), or until the
      // 7-day TTL expires. Self-heals within one cron cycle once KV reads recover.
      await env.JR_STATE.delete(errorStateKey).catch((e) => {
        console.error("Failed to clear error-active state from KV:", e);
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
      let secretMatches = false;
      if (provided && provided.length <= 512) {
        try {
          secretMatches = await timingSafeStringEqual(provided, env.CHECK_SECRET);
        } catch {
          // fail closed: treat crypto errors as non-match
        }
      }
      if (!secretMatches) {
        return new Response("Forbidden", { status: 403 });
      }

      // Note: /check intentionally does not read or update the error-active state machine
      // (state:__error-active). Error dedup and one-shot alerts are managed by the scheduled
      // handler only. A manual /check during an outage will not suppress or trigger error alerts.
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
