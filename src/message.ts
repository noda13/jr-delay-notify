import { RouteStatus, STATUS, WatchTarget } from "./config";

/**
 * Builds the LINE notification text for a status change.
 *
 * @param target  - The watch target whose status changed.
 * @param newStatus  - The new (current) status.
 * @param description - The gaikyo honbun text from JR Hokkaido.
 * @param updatedAt  - The timestamp string from JR Hokkaido JSON.
 */
export function buildNotificationText(
  target: WatchTarget,
  newStatus: RouteStatus,
  description: string,
  updatedAt: string,
): string {
  if (newStatus === STATUS.DISRUPTED) {
    return [
      `⚠️ 【運行情報】${target.label}`,
      ``,
      description,
      ``,
      `（${updatedAt}）`,
      `詳細: https://www3.jrhokkaido.co.jp/webunkou/`,
    ].join("\n");
  } else {
    return [
      `✅ 【復旧情報】${target.label}`,
      ``,
      `運行が正常に戻りました。`,
      ``,
      `（${updatedAt}）`,
    ].join("\n");
  }
}
