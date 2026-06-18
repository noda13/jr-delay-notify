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
  if (notify && !(result.status === STATUS.NORMAL && !notifyOnRecovery)) {
    const text = buildNotificationText(target, result.status, result.description, result.updatedAt);
    try {
      await sendLineMessage(env.LINE_CHANNEL_ACCESS_TOKEN, text);
      notified = true;
    } catch (lineErr) {
      // Log LINE failure; preserve previous status so next run retries notification
      console.error(`LINE notification failed for ${target.id}:`, lineErr);
      lineFailed = true;
      // Note: consecutive LINE failures across multiple transitions may collapse intermediate states.
      // The current polling cadence (≥5 min) makes this unlikely in practice.
    }
  }

  // On LINE failure: preserve previous status so next run re-attempts notification
  const persistStatus = lineFailed ? (previous?.status ?? result.status) : result.status;
  const newState: StoredState = {
    status: persistStatus,
    notifiedAt: notified ? new Date().toISOString() : (previous?.notifiedAt ?? ""),
    description: lineFailed ? (previous?.description ?? result.description) : result.description,
  };
  await writeState(env.JR_STATE, target.id, newState);

  return { id: target.id, label: target.label, status: result.status, description: result.description, notified };
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

    const failedTargets = settled
      .map((r, i) => ({ r, target: DEFAULT_TARGETS[i] }))
      .filter(({ r }) => r.status === "rejected");

    for (const { r, target } of failedTargets) {
      console.error(`Error processing target ${target.id}:`, (r as PromiseRejectedResult).reason);
    }

    if (failedTargets.length > 0 && env.LINE_CHANNEL_ACCESS_TOKEN) {
      const errorMsg = failedTargets.length === 1
        ? `🚨 【エラー】${failedTargets[0].target.label} の監視中にエラーが発生しました。詳細はログを確認してください。`
        : `🚨 【エラー】${failedTargets.length}件の監視でエラーが発生しました。詳細はログを確認してください。`;
      await sendLineMessage(env.LINE_CHANNEL_ACCESS_TOKEN, errorMsg).catch((e) => {
        console.error("Failed to send error notification to LINE:", e);
      });
    }
  },

  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/check") {
      if (!env.CHECK_SECRET || request.headers.get("X-Check-Secret") !== env.CHECK_SECRET) {
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

    return new Response(
      "jr-delay-notify worker is running.\nGET /check to trigger manually.",
      { headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  },
} satisfies ExportedHandler<Env>;
