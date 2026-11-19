import { useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { RotateCcwIcon } from "lucide-react";
import { LEVEL_COLORS, LEVEL_NAMES } from "../types";
import type { Histogram } from "../types";

interface HistogramChartProps {
  data: Histogram;
  onSelectRange: (from: number, to: number) => void;
  onReset?: () => void;
}

function formatAxisTime(ts: number, longRange: boolean): string {
  const options: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    minute: "2-digit",
  };

  if (longRange) {
    options.month = "short";
    options.day = "numeric";
  }

  return new Date(ts).toLocaleString(undefined, options);
}

function formatBucketRange(ts: number, bucketMs: number, longRange: boolean): string {
  const from = new Date(ts);
  const to = new Date(ts + bucketMs);

  const options: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    minute: "2-digit",
  };

  if (longRange) {
    options.month = "short";
    options.day = "numeric";
  }

  if (bucketMs < 60_000) {
    options.second = "2-digit";
  }

  return `${from.toLocaleString(undefined, options)} – ${to.toLocaleString(undefined, options)}`;
}

/**
 * Volume-by-level histogram. Hover for a bucket readout, click a bucket to zoom
 * into it, or drag across the chart to select a range.
 */
export default function HistogramChart({ data, onSelectRange, onReset }: HistogramChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ start: number; end: number } | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const [focused, setFocused] = useState(false);

  const totals = data.points.map((p) => p.counts.reduce((a, b) => a + b, 0));
  const totalEvents = totals.reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...totals);
  const longRange = data.to - data.from >= 24 * 60 * 60_000;
  const count = data.points.length;
  const safeFocus = Math.min(focusIndex, Math.max(0, count - 1));
  const safeHover = hoverIndex === null ? null : Math.min(hoverIndex, Math.max(0, count - 1));

  const activeIndex = drag
    ? Math.min(drag.end, Math.max(0, count - 1))
    : (safeHover ?? (focused ? safeFocus : null));

  const active = activeIndex === null ? undefined : data.points[activeIndex];
  const activeTotal = active?.counts.reduce((a, b) => a + b, 0) ?? 0;

  const indexAt = (clientX: number): number => {
    const el = ref.current;

    if (!el || count === 0) return 0;
    const rect = el.getBoundingClientRect();

    if (rect.width === 0) return 0;
    const fraction = (clientX - rect.left) / rect.width;

    return Math.min(count - 1, Math.max(0, Math.floor(fraction * count)));
  };

  const rangeFor = (start: number, end: number): { from: number; to: number } | null => {
    const first = data.points[Math.min(start, end)];
    const last = data.points[Math.max(start, end)];

    if (!first || !last) return null;

    return { from: first.ts, to: last.ts + data.bucketMs };
  };

  const applyRange = (start: number, end: number): void => {
    const range = rangeFor(start, end);

    if (!range) return;

    if (range.from <= data.from && range.to >= data.to) return;
    onSelectRange(range.from, range.to);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || count === 0) return;
    const index = indexAt(event.clientX);

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ start: index, end: index });
    setHoverIndex(index);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const index = indexAt(event.clientX);

    if (!drag) {
      setHoverIndex(index);

      return;
    }

    setDrag((current) => (current ? { ...current, end: index } : current));
  };

  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const index = indexAt(event.clientX);
    const start = drag?.start;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    setDrag(null);
    setHoverIndex(null);

    if (start === undefined) return;
    applyRange(start, index);
  };

  const cancelDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    setDrag(null);
    setHoverIndex(null);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (count === 0) return;

    switch (event.key) {
      case "ArrowLeft":
        event.preventDefault();
        setFocusIndex((current) => Math.max(0, current - 1));
        break;
      case "ArrowRight":
        event.preventDefault();
        setFocusIndex((current) => Math.min(count - 1, current + 1));
        break;
      case "Home":
        event.preventDefault();
        setFocusIndex(0);
        break;
      case "End":
        event.preventDefault();
        setFocusIndex(count - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        applyRange(safeFocus, safeFocus);
        break;
      case "Escape":
        event.currentTarget.blur();
        break;
    }
  };

  const dragRange = drag ? rangeFor(drag.start, drag.end) : null;

  const dragLeft =
    drag === null || data.points.length === 0
      ? 0
      : (Math.min(drag.start, drag.end) / data.points.length) * 100;

  const dragWidth =
    drag === null || data.points.length === 0
      ? 0
      : ((Math.abs(drag.end - drag.start) + 1) / data.points.length) * 100;

  const activeLeft =
    activeIndex === null || data.points.length === 0
      ? 0
      : ((activeIndex + 0.5) / data.points.length) * 100;

  return (
    <div className="select-none border-b border-white/[0.08] bg-ink-950/40">
      <div className="flex h-5 items-center justify-between px-3 font-mono text-[9px] tracking-[0.12em] text-mist-faint uppercase">
        <span className="min-w-0 flex-1 truncate text-mist-dim normal-case tracking-normal">
          {dragRange
            ? formatBucketRange(dragRange.from, dragRange.to - dragRange.from, longRange)
            : active
              ? formatBucketRange(active.ts, data.bucketMs, longRange)
              : "log volume"}
        </span>
        <span className="flex shrink-0 items-center gap-2 normal-case tracking-normal">
          {active && (
            <span className="flex items-center gap-1.5 text-mist">
              <span>
                {activeTotal.toLocaleString()} event
                {activeTotal === 1 ? "" : "s"}
              </span>
              <span className="flex items-center gap-1" aria-hidden="true">
                {active.counts.map((eventCount, level) =>
                  eventCount > 0 ? (
                    <span
                      key={level}
                      className="size-1.5 rounded-full"
                      style={{ backgroundColor: LEVEL_COLORS[level] ?? "#6b756c" }}
                      title={LEVEL_NAMES[level]}
                    />
                  ) : null,
                )}
              </span>
            </span>
          )}
          {onReset ? (
            <button
              type="button"
              onClick={onReset}
              className="flex items-center gap-1 text-[9px] text-gold/80 transition-colors hover:text-gold focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gold/40"
            >
              <RotateCcwIcon className="size-2.5" />
              reset
            </button>
          ) : (
            !active && (
              <span className="text-mist-dim normal-case tracking-normal">drag to zoom</span>
            )
          )}
        </span>
      </div>

      <div className="px-2">
        {/* Pointer drag is the primary interaction; the filter time controls
            provide a fully keyboard-accessible range, and arrows + Enter work
            here too. */}
        {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
        <div
          ref={ref}
          role="application"
          aria-label={`Log volume histogram, ${totalEvents.toLocaleString()} events. Drag across the chart to zoom, or focus it and use the arrow keys plus Enter.`}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finishDrag}
          onPointerCancel={cancelDrag}
          onPointerLeave={() => {
            if (!drag) setHoverIndex(null);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
          className={`relative flex h-20 touch-none items-stretch gap-px focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-gold/40 ${
            drag ? "cursor-col-resize" : "cursor-crosshair"
          }`}
        >
          {data.points.map((point, i) => {
            const total = totals[i] ?? 0;
            const fill = (total / max) * 100;

            return (
              <div
                key={point.ts}
                className="relative flex h-full min-w-0 flex-1 flex-col-reverse justify-start overflow-hidden rounded-t-[2px]"
                style={{ opacity: total === 0 ? 0.45 : 1 }}
                aria-hidden="true"
              >
                {total === 0 && <div className="h-px w-full bg-white/[0.08]" />}
                {point.counts.map((eventCount, level) => {
                  if (eventCount === 0) return null;
                  const share = (eventCount / total) * fill;

                  return (
                    <div
                      key={level}
                      style={{
                        height: `${share}%`,
                        backgroundColor: LEVEL_COLORS[level] ?? "#6b756c",
                      }}
                    />
                  );
                })}
              </div>
            );
          })}

          {activeIndex !== null && !drag && (
            <div
              className="pointer-events-none absolute inset-y-0 w-px bg-white/20"
              style={{ left: `${activeLeft}%` }}
            />
          )}

          {totalEvents === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[10px] text-mist-faint">
              no events in this window
            </div>
          )}

          {drag && dragRange && (
            <div
              className="pointer-events-none absolute inset-y-0 rounded-[2px] border border-gold/40 bg-gold/[0.08]"
              style={{ left: `${dragLeft}%`, width: `${dragWidth}%` }}
            />
          )}
        </div>

        <div className="flex justify-between px-1 pt-1 pb-1 font-mono text-[9px] text-mist-faint">
          <span>{formatAxisTime(data.from, longRange)}</span>
          <span>{formatAxisTime(data.to, longRange)}</span>
        </div>
      </div>
    </div>
  );
}
