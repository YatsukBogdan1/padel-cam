/** Presentation helpers. Kept free of React so they stay trivially testable. */

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

export function formatDuration(startedAt: number, stoppedAt: number | null): string {
  if (!stoppedAt) return '—';
  const seconds = Math.max(0, Math.round((stoppedAt - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "3 min ago" — used for camera last-seen, where absolute time is noise. */
export function formatRelative(ms: number | null): string {
  if (!ms) return 'never';
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/**
 * Join metadata parts with a separator, dropping the ones that formatted to a
 * placeholder. Without this a recording with neither a duration nor a size
 * renders as "— · —", which reads like a bug rather than "not known yet".
 */
export function joinMeta(...parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => Boolean(p) && p !== '—').join(' · ');
}
