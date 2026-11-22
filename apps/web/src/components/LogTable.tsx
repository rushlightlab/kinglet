import { useEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { RefObject } from "react";
import type { KingletEvent } from "../types";
import { pad } from "../time";
import Logo from "./Logo";
import { LevelBadge } from "./LevelBadge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";

// Varied widths so the placeholder reads as log lines, not a grid.
const SKELETON_MESSAGE_WIDTHS = ["w-[46%]", "w-[62%]", "w-[38%]", "w-[54%]", "w-[70%]", "w-[42%]"];

interface LogTableProps {
  events: KingletEvent[];
  scrollRef: RefObject<HTMLDivElement | null>;
  onSelect: (event: KingletEvent) => void;
  selectedId: number | null;
  cursorId: number | null;
  /** The first load hasn't finished: show placeholder rows, not "no events". */
  loading?: boolean;
}

export default function LogTable({
  events,
  scrollRef,
  onSelect,
  selectedId,
  cursorId,
  loading = false,
}: LogTableProps) {
  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 27,
    overscan: 10,
  });

  // Keep the keyboard cursor in view.
  useEffect(() => {
    if (cursorId === null) return;
    const index = events.findIndex((e) => e.id === cursorId);

    if (index >= 0) virtualizer.scrollToIndex(index, { align: "auto" });
  }, [cursorId, events, virtualizer]);

  if (events.length === 0 && loading) {
    return (
      <div className="h-full overflow-hidden font-mono text-xs">
        <p role="status" className="sr-only">
          Loading events…
        </p>
        {Array.from({ length: 18 }, (_, row) => (
          <div
            key={row}
            aria-hidden="true"
            className="flex h-[27px] items-center gap-3 border-b border-l-2 border-b-white/[0.04] border-l-transparent px-4"
            style={{ opacity: 1 - row * 0.045 }}
          >
            <Skeleton className="h-3 w-20 shrink-0" />
            <Skeleton className="h-3.5 w-11 shrink-0" />
            <Skeleton className="h-3 w-24 shrink-0" />
            <Skeleton
              className={`h-3 ${SKELETON_MESSAGE_WIDTHS[row % SKELETON_MESSAGE_WIDTHS.length]}`}
            />
          </div>
        ))}
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="relative h-full overflow-y-auto">
        <div className="k-bg-grid absolute inset-0" aria-hidden="true" />
        <div className="relative flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
          <Logo className="h-8 w-8 text-gold/60" />
          <p className="font-mono text-xs text-mist-dim">
            No events match. Loosen the filters or widen the window.
          </p>
          <p className="font-mono text-xs text-mist-dim">New events appear here as they arrive.</p>
        </div>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto font-mono text-xs">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((item) => {
          const event = events[item.index];

          if (!event) return null;
          const selected = event.id === selectedId;
          const isCursor = event.id === cursorId;

          return (
            <div
              key={event.id}
              onClick={() => onSelect(event)}
              role="button"
              tabIndex={0}
              onKeyDown={(event_) => {
                if (event_.key === "Enter" || event_.key === " ") {
                  event_.preventDefault();
                  onSelect(event);
                }
              }}
              aria-label={`Open event: ${event.message.slice(0, 80)}`}
              className={`absolute left-0 top-0 flex w-full cursor-pointer items-center gap-3 border-b border-l-2 border-b-white/[0.04] px-4 ${
                isCursor
                  ? "border-l-gold bg-ink-800"
                  : selected
                    ? "border-l-transparent bg-ink-850"
                    : "border-l-transparent hover:bg-ink-850/60"
              }`}
              style={{ height: item.size, transform: `translateY(${item.start}px)` }}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="w-20 shrink-0 text-mist-faint">{formatTime(event.ts)}</span>
                </TooltipTrigger>
                <TooltipContent>{new Date(event.ts).toISOString()}</TooltipContent>
              </Tooltip>
              <LevelBadge level={event.level} />
              <span className="w-24 shrink-0 truncate text-mist-dim">{event.service ?? "—"}</span>
              <span className="truncate text-mist">{event.message}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);

  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
