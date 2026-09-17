export function remainingQuota(payload: any): number | null {
  const buckets = payload?.rateLimitsByLimitId;
  const snapshots = buckets && Object.keys(buckets).length ? Object.values(buckets) : [payload?.rateLimits];
  const values: number[] = [];
  for (const snapshot of snapshots as any[]) {
    if (!snapshot?.primary && !snapshot?.secondary) return null;
    for (const window of [snapshot?.primary, snapshot?.secondary]) {
      if (window == null) continue;
      if (typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) return null;
      values.push(Math.max(0, Math.min(100, 100 - window.usedPercent)));
    }
  }
  return values.length ? Math.min(...values) : null;
}
export function shouldUseSubscription(enabled: boolean, connected: boolean, remaining: number | null) {
  return enabled && connected && remaining !== null && remaining > 50;
}
