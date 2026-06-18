import { RouteStatus, StoredState } from "./config";

/** KV key for a target's stored state */
function stateKey(targetId: string): string {
  return `state:${targetId}`;
}

/** Runtime shape guard for StoredState */
function isValidStoredState(v: unknown): v is StoredState {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  if (typeof s.status !== "number") return false;
  if (typeof s.notifiedAt !== "string") return false;
  if (typeof s.description !== "string") return false;
  if (s.status !== 0 && s.status !== 1) return false;
  return true;
}

/**
 * Reads the previously stored state for a target from KV.
 * Returns null if no state has been stored yet (first run).
 */
export async function readState(
  kv: KVNamespace,
  targetId: string,
): Promise<StoredState | null> {
  const raw = await kv.get(stateKey(targetId));
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isValidStoredState(parsed)) {
      console.warn(`[jr-delay-notify] Invalid KV state shape for "${targetId}" — treating as first run.`);
      return null;
    }
    return parsed;
  } catch {
    console.warn(`[jr-delay-notify] Failed to parse KV state for "${targetId}" — treating as first run.`);
    return null;
  }
}

/**
 * Writes the current state to KV.
 * Uses 365-day TTL to auto-clean stale entries.
 */
export async function writeState(
  kv: KVNamespace,
  targetId: string,
  state: StoredState,
): Promise<void> {
  await kv.put(stateKey(targetId), JSON.stringify(state), {
    expirationTtl: 60 * 60 * 24 * 365, // 365 days
  });
}

/**
 * Determines whether a notification should be sent.
 *
 * Rules:
 * - No previous state → first run, save state silently (no notification on first run).
 * - Status changed from NORMAL(0) → DISRUPTED(1) → notify.
 * - Status changed from DISRUPTED(1) → NORMAL(0) → notify (recovery).
 * - Status unchanged → do not notify.
 */
export function shouldNotify(
  previous: StoredState | null,
  newStatus: RouteStatus,
): boolean {
  if (previous === null) return false; // first run: silent
  return previous.status !== newStatus || previous.pendingNotify === true;
}
