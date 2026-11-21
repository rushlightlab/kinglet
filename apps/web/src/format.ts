/**
 * Human formatting for operational values (byte sizes, durations, timestamps).
 * Kept dependency-free and deterministic; the caller decides precision.
 */

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** `421888` -> `412 KB`. Binary steps, one decimal below 10 units. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";

  if (!Number.isFinite(bytes) || bytes < 0) return "—";

  if (bytes < 1024) return `${Math.round(bytes)} B`;

  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const unit = BYTE_UNITS[unitIndex] ?? "B";
  const digits = value >= 10 ? 0 : 1;

  return `${value.toFixed(digits)} ${unit}`;
}

/** `3720000` -> `1h 2m`. Sub-second durations stay in milliseconds. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";

  if (!Number.isFinite(ms) || ms < 0) return "—";

  if (ms < 1000) return `${Math.round(ms)}ms`;

  const totalSeconds = Math.round(ms / 1000);

  if (totalSeconds < 60) return `${totalSeconds}s`;

  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];

  if (days > 0) parts.push(`${days}d`);

  if (hours > 0) parts.push(`${hours}h`);

  if (minutes > 0 && days === 0) parts.push(`${minutes}m`);

  if (seconds > 0 && days === 0 && hours === 0) parts.push(`${seconds}s`);

  return parts.join(" ") || "0s";
}

/** Compact relative time: `just now`, `12m ago`, `3h ago`, `4d ago`, then a date. */
export function formatRelativeTime(ts: number | null | undefined, now = Date.now()): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return "—";

  const diff = now - ts;

  if (diff < 0) {
    const ahead = -diff;

    if (ahead < MINUTE_MS) return "in a moment";

    if (ahead < HOUR_MS) return `in ${Math.round(ahead / MINUTE_MS)}m`;

    if (ahead < DAY_MS) return `in ${Math.round(ahead / HOUR_MS)}h`;

    return new Date(ts).toLocaleDateString();
  }

  if (diff < MINUTE_MS) return "just now";

  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)}m ago`;

  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)}h ago`;

  if (diff < 7 * DAY_MS) return `${Math.floor(diff / DAY_MS)}d ago`;

  return new Date(ts).toLocaleDateString();
}

/** Full local date and time for history tables and confirmation dialogs. */
export function formatDateTime(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return "—";

  return new Date(ts).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Webhook URLs are bearer secrets. Lists and toasts may show the origin only;
 * the full value is available exclusively in the admin edit dialog.
 */
export function maskWebhookUrl(raw: string): string {
  if (!raw) return "not configured";

  try {
    const url = new URL(raw);

    return `${url.protocol}//${url.host}/…`;
  } catch {
    return "endpoint configured";
  }
}

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;

/**
 * Errors and delivery details are displayed verbatim, but a URL inside them
 * is still a bearer secret. Replace every absolute URL with its masked origin.
 */
export function redactWebhookUrls(text: string): string {
  return text.replace(URL_PATTERN, (url) => maskWebhookUrl(url));
}

/** `42h` style coverage estimate from a run interval and a snapshot count. */
export function formatCoverage(count: number, intervalMs: number | null): string {
  if (count <= 0) return "no snapshots";

  if (intervalMs === null || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    return `${count} snapshot${count === 1 ? "" : "s"}`;
  }

  return `${count} snapshot${count === 1 ? "" : "s"} × ${formatDuration(intervalMs)} ≈ ${formatDuration(
    intervalMs * count,
  )}`;
}
