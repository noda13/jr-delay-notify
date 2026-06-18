import { RouteStatus, StoredState, WatchTarget } from "./config";

/** KV key for a target's stored state */
function stateKey(targetId: string): string {
  return `state:${targetId}`;
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
    return JSON.parse(raw) as StoredState;
  } catch {
    return null;
  }
}

/**
 * Writes the current state to KV.
 * Uses 7-day TTL to auto-clean stale entries.
 */
export async function writeState(
  kv: KVNamespace,
  targetId: string,
  state: StoredState,
): Promise<void> {
  await kv.put(stateKey(targetId), JSON.stringify(state), {
    expirationTtl: 60 * 60 * 24 * 7, // 7 days
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
  return previous.status !== newStatus;
}
