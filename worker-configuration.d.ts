// Generated manually — reflects wrangler.jsonc bindings and vars
interface Env {
  JR_STATE: KVNamespace;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  /** "true" | "false" — whether to send a LINE message when service recovers to normal */
  NOTIFY_ON_RECOVERY: string;
  /** Optional secret for the /check HTTP trigger — if set, X-Check-Secret header must match */
  CHECK_SECRET?: string;
}
