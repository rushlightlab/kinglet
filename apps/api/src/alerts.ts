import { isUuid } from "./auth/ids.ts";

/**
 * Alert read filters. This is deliberately a closed vocabulary: the route
 * never passes a caller-supplied column or SQL expression to the query helper.
 */
export type AlertState = "fired" | "resolved";

export const ALERT_STATES: readonly AlertState[] = ["fired", "resolved"];

/** Same read window as events; bounds are optional for alert history. */
export const ALERT_WINDOW_MS = 31 * 24 * 3_600_000;

const FUTURE_SKEW_MS = 5 * 60_000;

export interface RawAlertFilters {
  monitorId?: string;
  state?: string;
  from?: string;
  to?: string;
}

export interface AlertReadFilters {
  monitorId: string | null;
  state: AlertState | null;
  from: number | null;
  to: number | null;
}

export type AlertFilterResult =
  | { ok: true; filters: AlertReadFilters }
  | { ok: false; error: string };

function isAlertState(value: string): value is AlertState {
  return ALERT_STATES.some((state) => state === value);
}

function parseEpoch(raw: string): number | null {
  const value = Number(raw);

  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Validate `monitorId`, `state`, and the optional `firedAt` window. With no
 * bounds the list keeps its all-time behavior; any bound clamps the window to
 * 31 days and rejects an inverted or future-skewed range.
 */
export function parseAlertReadFilters(raw: RawAlertFilters, now = Date.now()): AlertFilterResult {
  let monitorId: string | null = null;

  if (raw.monitorId !== undefined) {
    if (!isUuid(raw.monitorId)) return { ok: false, error: "invalid monitor id" };

    monitorId = raw.monitorId.toLowerCase();
  }

  let state: AlertState | null = null;

  if (raw.state !== undefined) {
    if (!isAlertState(raw.state)) return { ok: false, error: "state must be fired or resolved" };

    state = raw.state;
  }

  let from: number | null = null;

  if (raw.from !== undefined) {
    from = parseEpoch(raw.from);

    if (from === null) return { ok: false, error: "from/to must be epoch milliseconds" };
  }

  let to: number | null = null;

  if (raw.to !== undefined) {
    to = parseEpoch(raw.to);

    if (to === null) return { ok: false, error: "from/to must be epoch milliseconds" };
  }

  if (from !== null && to !== null && from > to) {
    return { ok: false, error: "from must be before to" };
  }

  if (from !== null || to !== null) {
    const upper = Math.min(to ?? now, now + FUTURE_SKEW_MS);
    const start = from ?? upper - ALERT_WINDOW_MS;

    if (start > upper) return { ok: false, error: "from must be before to" };
    from = Math.max(start, upper - ALERT_WINDOW_MS);
    to = upper;
  }

  return { ok: true, filters: { monitorId, state, from, to } };
}
