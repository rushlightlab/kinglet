import { useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { RotateCcwIcon, XIcon } from "lucide-react";
import { LEVEL_COLORS, LEVEL_NAMES } from "../types";
import type { Histogram } from "../types";

interface HistogramChartProps {
  data: Histogram;
  onSelectRange: (from: number, to: number) => void;
  onReset?: () => void;
  onFilterLevel: (level: string) => void;
}

type Selection = { start: number; end: number };

type DragEdge = "start" | "end";

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

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;

  const minutes = Math.round(ms / 60_000);

  if (minutes < 60) return `${minutes}m`;

  const hours = minutes / 60;

  if (hours < 24) return `${hours % 1 === 0 ? hours : hours.toFixed(1)}h`;

  const days = hours / 24;

  return `${days % 1 === 0 ? days : days.toFixed(1)}d`;
}

/**
 * Volume-by-level histogram.
 *
 * Drag to select a range, drag the selection handles to refine it, then press
 * Zoom (or Enter). Clicking a colored level segment filters that level.
 */
export default function HistogramChart({
  data,
  onSelectRange,
  onReset,
  onFilterLevel,
}: HistogramChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const pressedLevel = useRef<number | null>(null);
  const activeHandle = useRef<DragEdge | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [drag, setDrag] = useState<Selection | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const [focused, setFocused] = useState(false);

  const totals = data.points.map((p) => p.counts.reduce((a, b) => a + b, 0));
  const totalEvents = totals.reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...totals);
  const longRange = data.to - data.from >= 24 * 60 * 60_000;
  const count = data.points.length;
  const safeFocus = Math.min(focusIndex, Math.max(0, count - 1));
  const safeHover = hoverIndex === null ? null : Math.min(hoverIndex, Math.max(0, count - 1));
  const preview = drag ?? selection;
  const previewRange = preview ? rangeFor(preview.start, preview.end) : null;
  const previewCount = preview ? countRange(preview.start, preview.end) : 0;
  const activeIndex = preview ? null : (safeHover ?? (focused ? safeFocus : null));
  const active = activeIndex === null ? undefined : data.points[activeIndex];
  const activeTotal = active?.counts.reduce((a, b) => a + b, 0) ?? 0;

  function indexAt(clientX: number): number {
    const el = ref.current;

    if (!el || count === 0) return 0;
    const rect = el.getBoundingClientRect();

    if (rect.width === 0) return 0;
    const fraction = (clientX - rect.left) / rect.width;

    return Math.min(count - 1, Math.max(0, Math.floor(fraction * count)));
  }

  function rangeFor(start: number, end: number): { from: number; to: number } | null {
    const first = data.points[Math.min(start, end)];
    const last = data.points[Math.max(start, end)];

    if (!first || !last) return null;

    return { from: first.ts, to: last.ts + data.bucketMs };
  }

  function countRange(start: number, end: number): number {
    let total = 0;

    for (let i = Math.min(start, end); i <= Math.max(start, end); i++) {
      total += totals[i] ?? 0;
    }

    return total;
  }

  function applyRange(start: number, end: number): void {
    const range = rangeFor(start, end);

    if (!range) return;

    if (range.from <= data.from && range.to >= data.to) return;
    onSelectRange(range.from, range.to);
  }

  function applySelection(): void {
    if (!selection) return;
    const next = selection;

    setSelection(null);
    applyRange(next.start, next.end);
  }

  function clearSelection(): void {
    setSelection(null);
  }

  function filterLevel(level: number): void {
    const name = LEVEL_NAMES[level];

    if (!name) return;
    setSelection(null);
    setDrag(null);
    onFilterLevel(name);
  }

  function resetRange(): void {
    setSelection(null);
    setDrag(null);
    onReset?.();
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0 || count === 0) return;

    const target = event.target instanceof HTMLElement ? event.target : null;
    const segment = target?.closest<HTMLElement>("[data-level]");
    const level = segment ? Number(segment.dataset.level) : Number.NaN;

    pressedLevel.current = Number.isInteger(level) && level >= 0 && level <= 5 ? level : null;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ start: indexAt(event.clientX), end: indexAt(event.clientX) });
    setSelection(null);
    setHoverIndex(indexAt(event.clientX));
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const index = indexAt(event.clientX);

    if (!drag) {
      setHoverIndex(index);

      return;
    }

    setDrag((current) => (current ? { ...current, end: index } : current));
  }

  function finishDrag(event: ReactPointerEvent<HTMLDivElement>): void {
    const index = indexAt(event.clientX);
    const start = drag?.start;
    const level = pressedLevel.current;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    pressedLevel.current = null;
    setDrag(null);
    setHoverIndex(null);

    if (start === undefined) return;

    if (start === index) {
      if (level !== null) {
        filterLevel(level);

        return;
      }

      applyRange(start, index);

      return;
    }

    setSelection({ start: Math.min(start, index), end: Math.max(start, index) });
  }

  function cancelDrag(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    pressedLevel.current = null;
    setDrag(null);
    setHoverIndex(null);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
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

        if (selection) applySelection();
        else applyRange(safeFocus, safeFocus);

        break;
      case "Escape":
        if (selection) {
          event.preventDefault();
          setSelection(null);
        } else {
          event.currentTarget.blur();
        }

        break;
    }
  }

  function startHandleDrag(edge: DragEdge, event: ReactPointerEvent<HTMLButtonElement>): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    activeHandle.current = edge;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveHandle(event: ReactPointerEvent<HTMLButtonElement>): void {
    const edge = activeHandle.current;

    if (!edge) return;
    event.preventDefault();
    event.stopPropagation();
    const index = indexAt(event.clientX);

    setSelection((current) => {
      if (!current) return current;

      if (edge === "start") {
        return { ...current, start: Math.min(index, current.end) };
      }

      return { ...current, end: Math.max(index, current.start) };
    });
  }

  function finishHandle(event: ReactPointerEvent<HTMLButtonElement>): void {
    event.preventDefault();
    event.stopPropagation();

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    activeHandle.current = null;
  }

  function cancelHandle(event: ReactPointerEvent<HTMLButtonElement>): void {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    activeHandle.current = null;
  }

  function onHandleKeyDown(edge: DragEdge, event: ReactKeyboardEvent<HTMLButtonElement>): void {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      event.stopPropagation();
      const delta = event.key === "ArrowLeft" ? -1 : 1;

      setSelection((current) => {
        if (!current) return current;

        if (edge === "start") {
          return { ...current, start: Math.min(current.end, Math.max(0, current.start + delta)) };
        }

        return {
          ...current,
          end: Math.max(current.start, Math.min(count - 1, current.end + delta)),
        };
      });

      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      applySelection();

      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setSelection(null);
    }
  }

  const dragLeft =
    preview === null || count === 0 ? 0 : (Math.min(preview.start, preview.end) / count) * 100;

  const dragWidth =
    preview === null || count === 0
      ? 0
      : ((Math.abs(preview.end - preview.start) + 1) / count) * 100;

  const activeLeft = activeIndex === null || count === 0 ? 0 : ((activeIndex + 0.5) / count) * 100;

  const handleLeft = (edge: DragEdge): number => {
    if (!selection || count === 0) return 0;

    return ((edge === "start" ? selection.start : selection.end + 1) / count) * 100;
  };

  const previewEndPercent =
    preview === null || count === 0
      ? 0
      : ((Math.max(preview.start, preview.end) + 1) / count) * 100;

  const popupTransform =
    previewEndPercent > 62 ? "translate(calc(-100% - 8px), -50%)" : "translate(8px, -50%)";

  return (
    <div
      className="select-none border-b border-white/[0.08] bg-ink-950/40"
      onPointerLeave={() => {
        if (!drag) setHoverIndex(null);
      }}
    >
      <div className="flex h-5 items-center justify-between px-3 font-mono text-[9px] tracking-[0.12em] text-mist-faint uppercase">
        <span className="min-w-0 flex-1 truncate text-mist-dim normal-case tracking-normal">
          {previewRange
            ? formatBucketRange(previewRange.from, previewRange.to - previewRange.from, longRange)
            : active
              ? formatBucketRange(active.ts, data.bucketMs, longRange)
              : "log volume"}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 normal-case tracking-normal">
          {previewRange ? (
            <span className="text-mist">{previewCount.toLocaleString()} events</span>
          ) : active ? (
            <span className="flex items-center gap-1.5 text-mist">
              <span>
                {activeTotal.toLocaleString()} event
                {activeTotal === 1 ? "" : "s"}
              </span>
              <span className="flex items-center gap-0.5" aria-hidden="true">
                {active.counts.map((eventCount, level) =>
                  eventCount > 0 ? (
                    <span
                      key={level}
                      className="size-1.5 rounded-full"
                      style={{ backgroundColor: LEVEL_COLORS[level] ?? "#6b756c" }}
                      title={LEVEL_NAMES[level] ?? "level"}
                    />
                  ) : null,
                )}
              </span>
            </span>
          ) : null}

          {!selection &&
            (onReset ? (
              <button
                type="button"
                onClick={resetRange}
                title="Return to the last preset time window"
                className="flex h-4 items-center gap-1 rounded-[3px] border border-gold/30 bg-gold/[0.06] px-1.5 text-[9px] text-gold/90 transition-colors hover:bg-gold/[0.12] hover:text-gold focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gold/40"
              >
                <RotateCcwIcon className="size-2.5" />
                zoom out
              </button>
            ) : (
              !active && <span className="text-mist-dim">drag to select</span>
            ))}
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
          aria-label={`Log volume histogram, ${totalEvents.toLocaleString()} events. Drag to select a time range, drag the selection handles to refine it, or click a colored segment to filter a level.`}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finishDrag}
          onPointerCancel={cancelDrag}
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
                      data-level={level}
                      title={`Filter ${LEVEL_NAMES[level] ?? "level"} events`}
                      className="cursor-pointer"
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

          {activeIndex !== null && !preview && (
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

          {preview && previewRange && (
            <div
              className="pointer-events-none absolute inset-y-0 rounded-[2px] border border-gold/40 bg-gold/[0.08]"
              style={{ left: `${dragLeft}%`, width: `${dragWidth}%` }}
            />
          )}

          {drag && (
            <div
              className="pointer-events-none absolute inset-y-0 w-px bg-white/30"
              style={{
                left: `${((Math.max(drag.start, drag.end) + 0.5) / count) * 100}%`,
              }}
            />
          )}

          {selection && (
            <>
              <button
                type="button"
                aria-label="Adjust selection start"
                title="Drag to adjust selection start"
                style={{ left: `${handleLeft("start")}%` }}
                onPointerDown={(event) => startHandleDrag("start", event)}
                onPointerMove={moveHandle}
                onPointerUp={finishHandle}
                onPointerCancel={cancelHandle}
                onKeyDown={(event) => onHandleKeyDown("start", event)}
                className="absolute inset-y-0 z-30 w-3 -translate-x-1/2 cursor-ew-resize touch-none focus-visible:outline-none"
              >
                <span className="absolute inset-y-1 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-gold shadow-[0_0_8px_rgba(251,191,36,0.35)]" />
                <span className="absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-gold/60 bg-ink-950" />
              </button>
              <button
                type="button"
                aria-label="Adjust selection end"
                title="Drag to adjust selection end"
                style={{ left: `${handleLeft("end")}%` }}
                onPointerDown={(event) => startHandleDrag("end", event)}
                onPointerMove={moveHandle}
                onPointerUp={finishHandle}
                onPointerCancel={cancelHandle}
                onKeyDown={(event) => onHandleKeyDown("end", event)}
                className="absolute inset-y-0 z-30 w-3 -translate-x-1/2 cursor-ew-resize touch-none focus-visible:outline-none"
              >
                <span className="absolute inset-y-1 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-gold shadow-[0_0_8px_rgba(251,191,36,0.35)]" />
                <span className="absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-gold/60 bg-ink-950" />
              </button>
            </>
          )}

          {previewRange && (
            <div
              role="group"
              aria-label="Selected time range"
              style={{ left: `${previewEndPercent}%`, transform: popupTransform }}
              onPointerDown={(event) => event.stopPropagation()}
              onPointerUp={(event) => event.stopPropagation()}
              className="pointer-events-none absolute top-1/2 z-40 flex w-max min-w-[150px] max-w-[230px] flex-col gap-1.5 rounded-[5px] border border-white/10 bg-ink-900/95 p-2 shadow-[0_10px_30px_rgba(0,0,0,0.5)] backdrop-blur"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex flex-col gap-0.5">
                  <span className="whitespace-nowrap font-mono text-[10px] text-mist">
                    {formatBucketRange(
                      previewRange.from,
                      previewRange.to - previewRange.from,
                      longRange,
                    )}
                  </span>
                  <span className="text-[9px] text-mist-faint">
                    {previewCount.toLocaleString()} events ·{" "}
                    {formatDuration(previewRange.to - previewRange.from)}
                  </span>
                </div>
                {selection && (
                  <button
                    type="button"
                    onClick={clearSelection}
                    aria-label="Cancel selection"
                    title="Cancel selection"
                    className="pointer-events-auto flex size-4 shrink-0 items-center justify-center rounded-[3px] text-mist-faint transition-colors hover:bg-white/[0.06] hover:text-mist focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gold/40"
                  >
                    <XIcon className="size-2.5" />
                  </button>
                )}
              </div>

              {selection ? (
                <button
                  type="button"
                  onClick={applySelection}
                  className="pointer-events-auto h-6 w-full rounded-[3px] bg-mist text-[10px] font-semibold text-ink-950 transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/50"
                >
                  Zoom In
                </button>
              ) : (
                <span className="text-[9px] text-mist-faint">release to select</span>
              )}
            </div>
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
