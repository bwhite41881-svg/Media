/**
 * Pure utilities for formatting view counts and deduplicating rapid repeated view pings.
 */

export const DEFAULT_VIEW_COOLDOWN_MS = 15_000;

/**
 * Formats a non-negative view count compactly (e.g., 0 -> "0", 1250 -> "1.3K", 2400000 -> "2.4M").
 */
export function formatCompactCount(rawCount?: number): string {
  const count = Math.max(0, Math.floor(Number(rawCount) || 0));
  if (count < 1_000) return count.toLocaleString();
  if (count < 1_000_000) {
    const val = count / 1_000;
    return `${val >= 100 ? Math.round(val) : val.toFixed(1).replace(/\.0$/, '')}K`;
  }
  const val = count / 1_000_000;
  return `${val >= 100 ? Math.round(val) : val.toFixed(1).replace(/\.0$/, '')}M`;
}

/**
 * Formats a non-negative view count with singular/plural label (e.g., "0 views", "1 view", "1.2K views").
 */
export function formatViewCount(rawCount?: number): string {
  const count = Math.max(0, Math.floor(Number(rawCount) || 0));
  if (count === 1) return '1 view';
  return `${formatCompactCount(count)} views`;
}

/**
 * Determines whether a view event from `viewerKey` on `targetId` should increment the counter,
 * mutating `recentViews` and pruning stale entries when the map grows large.
 */
export function shouldRecordView(
  viewerKey: string,
  targetId: string,
  nowMs: number,
  recentViews: Map<string, number>,
  cooldownMs = DEFAULT_VIEW_COOLDOWN_MS
): boolean {
  const safeViewer = String(viewerKey || 'anon').trim();
  const safeTarget = String(targetId || '').trim();
  if (!safeTarget) return false;

  // Periodic lightweight cleanup to keep in-memory map bounded
  if (recentViews.size > 5_000) {
    for (const [k, ts] of recentViews.entries()) {
      if (nowMs - ts >= cooldownMs) {
        recentViews.delete(k);
      }
    }
  }

  const key = `${safeViewer}::${safeTarget}`;
  const lastSeen = recentViews.get(key);
  if (typeof lastSeen === 'number' && nowMs - lastSeen < cooldownMs) {
    return false;
  }

  recentViews.set(key, nowMs);
  return true;
}
