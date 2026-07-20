// Console tracing for the session UI state sync pipeline (tabs + drafts shared
// through the daemon). Every decision that opens, closes, preserves, drops, or
// suppresses a tab logs here, so "a tab appeared / reappeared out of nowhere"
// reports can be diagnosed from the device console after the fact. Grep for
// "[tab-sync]". Intentionally active in production builds — the races this
// traces (stale snapshot replays, cross-device ping-pong) only occur on real
// multi-device sessions and are invisible in dev otherwise.
export function logTabSync(event: string, details: Record<string, unknown>): void {
  console.info(`[paseo:tab-sync] ${event}`, details);
}
