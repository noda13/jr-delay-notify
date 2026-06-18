/**
 * Configuration for JR delay monitoring targets.
 * Each WatchTarget defines one train line section to monitor.
 */

/** Area JSON endpoint keys for JR Hokkaido */
export const AREA_ENDPOINTS = {
  spo: "https://www3.jrhokkaido.co.jp/webunkou/json/area/area_01.json",
  doo: "https://www3.jrhokkaido.co.jp/webunkou/json/area/area_doo.json",
  donan: "https://www3.jrhokkaido.co.jp/webunkou/json/area/area_donan.json",
  dohoku: "https://www3.jrhokkaido.co.jp/webunkou/json/area/area_dohoku.json",
  doto: "https://www3.jrhokkaido.co.jp/webunkou/json/area/area_doto.json",
} as const;

/** Possible route status values from JR Hokkaido JSON */
export const STATUS = {
  /** No delays or cancellations */
  NORMAL: 0,
  /** Delay of 30+ minutes or cancellation in effect */
  DISRUPTED: 1,
} as const;

export type RouteStatus = 0 | 1;

/** A single train line section to watch */
export interface WatchTarget {
  /** Unique identifier, used as KV key prefix */
  id: string;
  /** Human-readable label for notification messages */
  label: string;
  /** Area key (e.g. "spo" for Sapporo suburban) */
  areaKey: keyof typeof AREA_ENDPOINTS;
  /**
   * Key in the JSON `senkuStatus` object.
   * e.g. "hakochise" for 函館・千歳線
   *
   * Available keys for spo area:
   *   express, airport, hakochise, hakodateLiner, hakodate,
   *   gakuen, sekisho, muroran, nemuro, hidaka,
   *   soya, sekihoku, furano, rumoi, senmo, hanasaki
   */
  senkuKey: string;
}

/** Stored state in KV per WatchTarget */
export interface StoredState {
  /** Last known status value */
  status: RouteStatus;
  /** ISO 8601 timestamp of last notification sent */
  notifiedAt: string;
  /** Description text from last status change */
  description: string;
  /** true if a notification was attempted but failed and should be retried next run */
  pendingNotify?: boolean;
}

/**
 * Default watch targets.
 * First entry is the child's commute route (稲積公園〜小樽, 函館本線/函館・千歳線 in Sapporo area).
 */
export const DEFAULT_TARGETS: WatchTarget[] = [
  {
    id: "hakodate-sapporo",
    label: "函館・千歳線（札幌近郊）",
    areaKey: "spo",
    senkuKey: "hakochise",
  },
  {
    id: "spo-airport",
    label: "エアポート（札幌近郊）",
    areaKey: "spo",
    senkuKey: "airport",
  },
];
