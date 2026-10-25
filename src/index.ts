import { DEFAULT_TARGETS, RouteStatus, STATUS, StoredState, WatchTarget } from "./config";
import { buildNotificationText } from "./message";
import { createTargetScraper, type ScrapeResult } from "./scraper";
import { readState, shouldNotify, writeState } from "./state";
import { LineRateLimitError, sendLineMessage } from "./line";

interface TargetResult {
  id: string;
  label: string;
  status: RouteStatus | -1;
  description: string;
  notified: boolean;
  /** true when a wanted notification could not be delivered (send error or missing token) */
  sendFailed: boolean;
}

// scrapeTarget (fetch non-2xx, JSON parse, unknown senkuKey) and readState (KV.get) can throw.
// Those errors propagate as rejected promises to Promise.allSettled in the callers.
// LINE send and KV write errors are caught internally and do NOT cause rejection.
async function processTarget(
  target: WatchTarget,
  env: Env,
  notifyOnRecovery: boolean,
  scrape: (target: WatchTarget) => Promise<ScrapeResult>,
): Promise<TargetResult> {
  const result = await scrape(target);
  const previous = await readState(env.JR_STATE, target.id);
  const notify = shouldNotify(previous, result.status);

  let notified = false;
  let lineFailed = false;
  let sendFailed = false;
  const sendWanted = notify && !(result.status === STATUS.NORMAL && !notifyOnRecovery);
  if (sendWanted) {
    if (!env.LINE_CHANNEL_ACCESS_TOKEN) {
      console.error(`[jr-delay-notify] LINE_CHANNEL_ACCESS_TOKEN is absent — notification skipped for ${target.id}. Check wrangler secrets.`);
      // Retry via pendingNotify so sendFailed persists across runs and the heartbeat stays silent
      // until the token is configured.
      lineFailed = true;
      sendFailed = true;
    } else {
      const text = buildNotificationText(target, result.status, result.description, result.updatedAt);
      try {
        await sendLineMessage(env.LINE_CHANNEL_ACCESS_TOKEN, text, env.LINE_TO);
        notified = true;
      } catch (lineErr) {
        // Rate-limit retries keep returning 429 until the monthly quota resets.
        const reason = lineErr instanceof LineRateLimitError ? "LINE rate limit" : "LINE notification failed";
        console.error(`${reason} for ${target.id}:`, lineErr);
        lineFailed = true;
        sendFailed = true;
      }
    }
  }

  const newState: StoredState = {
    status: result.status,
    ...(notified ? { notifiedAt: new Date().toISOString() } : (result.status === STATUS.DISRUPTED && previous?.notifiedAt) ? { notifiedAt: previous.notifiedAt } : {}),
    description: result.description,
    pendingNotify: lineFailed,
  };
  // Skip identical writes to conserve free-tier KV write quota.
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

  return { id: target.id, label: target.label, status: result.status, description: result.description, notified, sendFailed };
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
  if (v === "false" || v === "0" || v === "no") return false;
  if (v !== undefined && v !== "" && v !== "true" && v !== "1" && v !== "yes") {
    console.warn(`Unrecognized NOTIFY_ON_RECOVERY value "${env.NOTIFY_ON_RECOVERY}" — treating as enabled. Use "false" to disable.`);
  }
  return true;
}

async function pingHeartbeat(url: string): Promise<void> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    await res.body?.cancel();
    if (!res.ok) {
      console.warn(`Heartbeat ping returned ${res.status} — check HEARTBEAT_URL.`);
    }
  } catch (e) {
    console.error("Heartbeat ping failed:", e);
  }
}

interface FailedTarget {
  target: WatchTarget;
  reason: unknown;
}

// One-shot error alert state machine, shared by scheduled runs only (/check does not touch it).
async function handleErrorAlert(env: Env, failedTargets: FailedTarget[]): Promise<void> {
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

  for (const { target, reason } of failedTargets) {
    console.error(`Error processing target ${target.id}:`, reason);
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
        errorNotified = await sendLineMessage(env.LINE_CHANNEL_ACCESS_TOKEN, errorMsg, env.LINE_TO)
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
}

export default {
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const notifyOnRecovery = isRecoveryEnabled(env);
    const scrape = createTargetScraper();

    const settled = await Promise.allSettled(
      DEFAULT_TARGETS.map((target) => processTarget(target, env, notifyOnRecovery, scrape)),
    );

    const failedTargets = settled.flatMap((r, i) =>
      r.status === "rejected" ? [{ target: DEFAULT_TARGETS[i], reason: r.reason }] : [],
    );
    await handleErrorAlert(env, failedTargets);

    // Ping only when every target succeeded and every wanted notification was delivered, so an
    // external monitor also alerts on persistent scrape failures, LINE delivery failures
    // (e.g. expired token) or a stopped cron — cases the LINE error alert cannot report.
    const sendFailed = settled.some((r) => r.status === "fulfilled" && r.value.sendFailed);
    if (failedTargets.length === 0 && !sendFailed && env.HEARTBEAT_URL) {
      await pingHeartbeat(env.HEARTBEAT_URL);
    }
  },

  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/check") {
      if (request.method !== "GET") {
        return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } });
      }
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
      // Note: each /check call may trigger live LINE broadcasts — use sparingly to avoid
      // exhausting the monthly free-tier broadcast quota (200 msgs/mo).
      const notifyOnRecovery = isRecoveryEnabled(env);
      const scrape = createTargetScraper();
      const settled = await Promise.allSettled(
        DEFAULT_TARGETS.map((target) => processTarget(target, env, notifyOnRecovery, scrape)),
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
          sendFailed: false,
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
