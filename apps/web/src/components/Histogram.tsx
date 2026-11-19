import { useRef } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { LEVEL_COLORS } from "../types";
import type { Histogram } from "../types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Volume-by-level histogram. Drag across it to zoom into a time range.
 */
export default function HistogramChart({
  data,
  onSelectRange,
}: {
  data: Histogram;
  onSelectRange: (from: number, to: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const dragStart = useRef<number | null>(null);

  const totals = data.points.map((p) => p.counts.reduce((a, b) => a + b, 0));
  const max = Math.max(1, ...totals);

  const tsAt = (clientX: number): number | null => {
    const el = ref.current;
    if (!el || data.points.length === 0) return null;
    const rect = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const index = Math.floor(frac * data.points.length);
    return data.points[index]?.ts ?? null;
  };

  const onMouseDown = (e: ReactMouseEvent<HTMLDivElement>): void => {
    dragStart.current = tsAt(e.clientX);
  };

  const onMouseUp = (e: ReactMouseEvent<HTMLDivElement>): void => {
    const start = dragStart.current;
    dragStart.current = null;
    const end = tsAt(e.clientX);
    if (start === null || end === null) return;
    const from = Math.min(start, end);
    const to = Math.max(start, end) + data.bucketMs;
    if (to - from < data.bucketMs * 2) return; // accidental click, not a drag
    onSelectRange(from, to);
  };

  return (
    <div
      ref={ref}
      onMouseDown={onMouseDown}
      onMouseUp={onMouseUp}
      className="flex h-20 cursor-col-resize items-stretch gap-px border-b border-white/[0.08] px-2 py-1"
    >
      {data.points.map((point, i) => {
        const total = totals[i] ?? 0;
        const fill = (total / max) * 100;
        return (
          <Tooltip key={point.ts}>
            <TooltipTrigger asChild>
              <div
                className="flex h-full w-full flex-col-reverse justify-start rounded-t-[2px]"
                style={{ opacity: total === 0 ? 0.1 : 1 }}
              >
                {point.counts.map((count, level) => {
                  if (count === 0) return null;
                  const share = (count / total) * fill;
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
            </TooltipTrigger>
            <TooltipContent>
              <span className="flex flex-col gap-0.5">
                <span>{new Date(point.ts).toLocaleTimeString()}</span>
                <span className="text-mist-faint">
                  {total.toLocaleString()} event{total === 1 ? "" : "s"}
                </span>
              </span>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
