import { useVirtualizer } from "@tanstack/react-virtual";
import type { RefObject } from "react";
import type { KingletEvent } from "../types";
import { LevelBadge } from "./LevelBadge";

interface LogTableProps {
  events: KingletEvent[];
  scrollRef: RefObject<HTMLDivElement | null>;
  onSelect: (event: KingletEvent) => void;
  selectedId: number | null;
}

export default function LogTable({ events, scrollRef, onSelect, selectedId }: LogTableProps) {
  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 26,
    overscan: 10,
  });

  if (events.length === 0) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="flex h-full items-center justify-center px-4 text-center text-xs text-[#8b93a3]">
          No events match. Loosen the filters, widen the window, or hit “Spray demo logs”.
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
          return (
            <div
              key={event.id}
              onClick={() => onSelect(event)}
              className={`absolute left-0 top-0 flex w-full cursor-pointer items-center gap-3 border-b border-[#151a24] px-4 ${
                selected ? "bg-[#1a2233]" : "hover:bg-[#12161f]"
              }`}
              style={{ height: item.size, transform: `translateY(${item.start}px)` }}
            >
              <span className="w-20 shrink-0 text-[#8b93a3]">{formatTime(event.ts)}</span>
              <LevelBadge level={event.level} />
              <span className="w-24 shrink-0 truncate text-[#8b93a3]">{event.service ?? "—"}</span>
              <span className="truncate text-[#dbe0ea]">{event.message}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
