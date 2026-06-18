import { DEFAULT_TARGETS, STATUS, StoredState } from "./config";
import { buildNotificationText } from "./message";
import { scrapeTarget } from "./scraper";
import { readState, shouldNotify, writeState } from "./state";
import { sendLineMessage } from "./line";

export default {
  /**
   * Cron trigger handler: checks all DEFAULT_TARGETS and sends LINE
   * notifications if status has changed since last check.
   */
  async scheduled(
    _event: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const notifyOnRecovery = env.NOTIFY_ON_RECOVERY !== "false";

    for (const target of DEFAULT_TARGETS) {
      try {
        const result = await scrapeTarget(target);
        const previous = await readState(env.JR_STATE, target.id);

        if (shouldNotify(previous, result.status)) {
          // Skip recovery notification if disabled
          if (result.status === STATUS.NORMAL && !notifyOnRecovery) {
            // Still update state, just don't notify
          } else {
            const text = buildNotificationText(
              target,
              result.status,
              result.description,
              result.updatedAt,
            );
            await sendLineMessage(env.LINE_CHANNEL_ACCESS_TOKEN, text);
          }
        }

        // Always update state after processing
        const newState: StoredState = {
          status: result.status,
          notifiedAt: previous?.notifiedAt ?? new Date().toISOString(),
          description: result.description,
        };
        // Update notifiedAt only when we actually notified
        if (shouldNotify(previous, result.status)) {
          newState.notifiedAt = new Date().toISOString();
        }
        await writeState(env.JR_STATE, target.id, newState);
      } catch (err) {
        console.error(`Error processing target ${target.id}:`, err);
        // Notify admin of scraper failure via LINE if token is available
        if (env.LINE_CHANNEL_ACCESS_TOKEN) {
          try {
            await sendLineMessage(
              env.LINE_CHANNEL_ACCESS_TOKEN,
              `🚨 【エラー】${target.label} の監視中にエラーが発生しました。\n${String(err)}`,
            );
          } catch {
            // ignore secondary failure
          }
        }
      }
    }
  },

  /**
   * HTTP handler: manual trigger for testing.
   * GET /check → runs the same logic as scheduled, returns JSON summary.
   */
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/check") {
      const results: Array<{
        id: string;
        label: string;
        status: number;
        description: string;
        notified: boolean;
      }> = [];

      for (const target of DEFAULT_TARGETS) {
        try {
          const result = await scrapeTarget(target);
          const previous = await readState(env.JR_STATE, target.id);
          const notify = shouldNotify(previous, result.status);

          if (notify && env.LINE_CHANNEL_ACCESS_TOKEN) {
            const text = buildNotificationText(
              target,
              result.status,
              result.description,
              result.updatedAt,
            );
            await sendLineMessage(env.LINE_CHANNEL_ACCESS_TOKEN, text);
          }

          const newState: StoredState = {
            status: result.status,
            notifiedAt: notify
              ? new Date().toISOString()
              : (previous?.notifiedAt ?? new Date().toISOString()),
            description: result.description,
          };
          await writeState(env.JR_STATE, target.id, newState);

          results.push({
            id: target.id,
            label: target.label,
            status: result.status,
            description: result.description,
            notified: notify,
          });
        } catch (err) {
          results.push({
            id: target.id,
            label: target.label,
            status: -1,
            description: String(err),
            notified: false,
          });
        }
      }

      return Response.json({ ok: true, results });
    }

    return new Response(
      "jr-delay-notify worker is running.\nGET /check to trigger manually.",
      { headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  },
} satisfies ExportedHandler<Env>;
