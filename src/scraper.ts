import { AREA_ENDPOINTS, RouteStatus, WatchTarget } from "./config";

/** One entry in the gaikyo (概況) array */
export interface GaikyoEntry {
  time: string;
  title: string;
  honbun: string;
}

/** Parsed result for a single WatchTarget */
export interface ScrapeResult {
  target: WatchTarget;
  status: RouteStatus;
  /** Text from gaikyo[0].honbun describing the current situation */
  description: string;
  /** Raw "time" string from JSON, e.g. "2026年06月18日 11時30分現在" */
  updatedAt: string;
}

/** Raw structure of the JR Hokkaido area JSON */
interface AreaJson {
  time: string;
  today: {
    dateText: string;
    areaStatus: Record<string, number>;
    gaikyo: GaikyoEntry[];
    areaComments: unknown[];
    senkuStatus: Record<string, number>;
  };
  tomorrow: {
    dateText: string;
    areaStatus: Record<string, number>;
    gaikyo: GaikyoEntry[];
    areaComments: unknown[];
    senkuStatus: Record<string, number>;
  };
}

/**
 * Fetches the JR Hokkaido area JSON and extracts the status for the given target.
 * Throws if the fetch fails or the JSON is malformed.
 */
export async function scrapeTarget(target: WatchTarget): Promise<ScrapeResult> {
  const url = AREA_ENDPOINTS[target.areaKey];
  if (!url) {
    throw new Error(`Unknown areaKey: ${target.areaKey}`);
  }

  const res = await fetch(url, {
    headers: {
      "User-Agent": "jr-delay-notify/1.0",
      "Accept": "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`Fetch failed: ${res.status} ${res.statusText} for ${url}`);
  }

  // JR Hokkaido serves JSON with a UTF-8 BOM (﻿) — strip it before parsing
  const raw = await res.text();
  const json: AreaJson = JSON.parse(raw.replace(/^﻿/, ""));

  const rawStatus = json.today?.senkuStatus?.[target.senkuKey];
  const status: RouteStatus = rawStatus === 1 ? 1 : 0;

  // Pick the first non-empty gaikyo entry, or fall back to a default message
  const gaikyoEntry = json.today?.gaikyo?.find((g) => g.honbun.trim() !== "");
  const description =
    gaikyoEntry?.honbun ?? "現在、遅れに関する情報はありません。";

  return {
    target,
    status,
    description,
    updatedAt: json.time ?? "",
  };
}
