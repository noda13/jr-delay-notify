import { AREA_ENDPOINTS, RouteStatus, WatchTarget } from "./config";

/** Parsed result for a single WatchTarget */
export interface ScrapeResult {
  target: WatchTarget;
  status: RouteStatus;
  description: string;
  updatedAt: string;
}

interface AreaJson {
  time?: string;
  today: {
    senkuStatus: Record<string, number>;
    gaikyo: unknown[];
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fetchAreaJson(url: string, targetId: string): Promise<AreaJson> {
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

    // JR Hokkaido serves JSON with a UTF-8 BOM — strip it before parsing.
    const raw = (await res.text()).replace(/^\uFEFF/, "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Failed to parse JSON for target "${targetId}" (url: ${url}). Response may be non-JSON (maintenance page?)`);
    }

    if (!isRecord(parsed) || !isRecord(parsed.today)) {
      throw new Error(`Unexpected response shape for target "${targetId}" — API structure may have changed.`);
    }
    const senkuStatus = parsed.today.senkuStatus;
    if (!isRecord(senkuStatus)) {
      throw new Error(`Unexpected senkuStatus shape for target "${targetId}" — API structure may have changed.`);
    }
    if (parsed.today.gaikyo !== undefined && !Array.isArray(parsed.today.gaikyo)) {
      throw new Error(`Unexpected gaikyo shape for target "${targetId}" — API structure may have changed.`);
    }
    for (const [key, value] of Object.entries(senkuStatus)) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`Unexpected senkuStatus value for "${key}" (target "${targetId}") — API structure may have changed.`);
      }
    }

    return {
      ...(typeof parsed.time === "string" ? { time: parsed.time } : {}),
      today: {
        senkuStatus: senkuStatus as Record<string, number>,
        gaikyo: Array.isArray(parsed.today.gaikyo) ? parsed.today.gaikyo : [],
      },
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildResult(target: WatchTarget, json: AreaJson): ScrapeResult {
  const rawStatus = json.today.senkuStatus[target.senkuKey];
  if (rawStatus === undefined) {
    throw new Error(`senkuKey "${target.senkuKey}" not found in senkuStatus for target "${target.id}". API structure may have changed.`);
  }

  let status: RouteStatus;
  if (rawStatus === 0) {
    status = 0;
  } else if (rawStatus === 1) {
    status = 1;
  } else {
    // Fail-safe: treat any unknown numeric code as DISRUPTED to avoid missing real disruptions.
    console.warn(`[jr-delay-notify] Unexpected senkuStatus value ${rawStatus} for target "${target.id}" — treating as DISRUPTED.`);
    status = 1;
  }

  const gaikyoEntry = status === 1
    ? json.today.gaikyo.find((entry) => isRecord(entry) && typeof entry.honbun === "string" && entry.honbun.trim() !== "")
    : undefined;
  const description = gaikyoEntry && isRecord(gaikyoEntry)
    ? `エリア概況: ${gaikyoEntry.honbun as string}`
    : status === 1
      ? "詳細情報は公式サイトでご確認ください。"
      : "現在、遅れに関する情報はありません。";

  return {
    target,
    status,
    description,
    updatedAt: typeof json.time === "string" && json.time.trim() !== "" ? json.time : "時刻不明",
  };
}

/**
 * Creates a scraper scoped to one Worker invocation. Targets sharing an area
 * reuse the same in-flight response, while separate invocations always fetch
 * fresh data.
 */
export function createTargetScraper(): (target: WatchTarget) => Promise<ScrapeResult> {
  const areaRequests = new Map<string, Promise<AreaJson>>();

  return async (target) => {
    const url = AREA_ENDPOINTS[target.areaKey];
    if (!url) {
      throw new Error(`Unknown areaKey: ${target.areaKey}`);
    }

    let areaRequest = areaRequests.get(url);
    if (!areaRequest) {
      areaRequest = fetchAreaJson(url, target.id);
      areaRequests.set(url, areaRequest);
    }
    return buildResult(target, await areaRequest);
  };
}

/** Fetches and parses one target without sharing an area response. */
export async function scrapeTarget(target: WatchTarget): Promise<ScrapeResult> {
  return createTargetScraper()(target);
}
