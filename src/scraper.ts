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

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "jr-delay-notify/1.0",
        "Accept": "application/json",
      },
    });

    if (!res.ok) {
      throw new Error(`Fetch failed: ${res.status} ${res.statusText} for ${url}`);
    }

    // JR Hokkaido serves JSON with a UTF-8 BOM — strip it via charCodeAt before parsing
    const raw = await res.text();
    const stripped = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
    let json: AreaJson;
    try {
      json = JSON.parse(stripped) as AreaJson;
    } catch {
      throw new Error(`Failed to parse JSON for target "${target.id}" (url: ${url}). Response may be non-JSON (maintenance page?)`);
    }

    if (typeof json.today?.senkuStatus !== "object" || json.today.senkuStatus === null) {
      throw new Error(`Unexpected senkuStatus shape for target "${target.id}" — API structure may have changed.`);
    }

    const rawStatus = json.today?.senkuStatus?.[target.senkuKey];
    if (rawStatus === undefined) {
      throw new Error(`senkuKey "${target.senkuKey}" not found in senkuStatus for target "${target.id}". API structure may have changed.`);
    }
    let status: RouteStatus;
    if (rawStatus === 0) {
      status = 0;
    } else if (rawStatus === 1) {
      status = 1;
    } else {
      console.warn(`[jr-delay-notify] Unexpected senkuStatus value ${rawStatus} for target "${target.id}" — treating as DISRUPTED.`);
      status = 1;
    }

    // Pick the first non-empty gaikyo entry only when this route is disrupted,
    // to avoid attaching area-wide disruption text to a normal-status route.
    const gaikyoArray = Array.isArray(json.today?.gaikyo) ? json.today.gaikyo : [];
    const gaikyoEntry = status === 1
      ? gaikyoArray.find(
          (g) => g != null && typeof g === "object" && typeof g.honbun === "string" && g.honbun.trim() !== "",
        )
      : undefined;
    const description =
      (gaikyoEntry ? `エリア概況: ${gaikyoEntry.honbun}` : null) ??
      (status === 1 ? "詳細情報は公式サイトでご確認ください。" : "現在、遅れに関する情報はありません。");

    return {
      target,
      status,
      description,
      updatedAt: typeof json.time === "string" ? json.time : "",
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
