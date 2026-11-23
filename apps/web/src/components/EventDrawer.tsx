import { memo, useMemo, useState } from "react";
import type { KingletEvent } from "../types";
import { LevelBadge } from "./LevelBadge";
import { FilterIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isString } from "../json";
import type { JsonValue } from "../json";
import { fieldFilterTerm, fieldLeaves } from "../query";
import type { FieldLeaf } from "../query";
import CopyButton from "./CopyButton";

const EventDrawer = memo(function EventDrawer({
  event,
  onClose,
  onFilter,
}: {
  event: KingletEvent;
  onClose: () => void;
  /** Adds a filter term to the current search. */
  onFilter: (term: string) => void;
}) {
  const [rawOpen, setRawOpen] = useState(false);
  const leaves = useMemo(() => (event.fields ? fieldLeaves(event.fields) : []), [event.fields]);

  return (
    <aside className="absolute right-0 top-0 z-10 flex h-full w-[26rem] flex-col overflow-y-auto border-l border-white/[0.08] bg-ink-900 p-4">
      <div className="flex items-center justify-between">
        <LevelBadge level={event.level} />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="chip" size="icon-xs" onClick={onClose} aria-label="Close">
              <XIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Close (Esc)</TooltipContent>
        </Tooltip>
      </div>
      <dl className="mt-4 flex flex-col gap-2 font-mono text-xs">
        <Row label="time" value={new Date(event.ts).toISOString()} />
        <Row label="service" value={event.service ?? "—"} />
        <Row label="env" value={event.env ?? "—"} />
        <Row
          label="api key"
          value={event.apiKeyId ? `key ${event.apiKeyId.slice(0, 8)}…` : "session"}
        />
        <Row label="uid" value={event.uid ?? "—"} />
        <Row label="id" value={String(event.id)} />
      </dl>
      {event.uid && (
        <div className="mt-2">
          <CopyButton value={event.uid} label="copy event id" />
        </div>
      )}
      <div className="mt-4">
        <div className="k-kicker">message</div>
        <pre className="mt-1 whitespace-pre-wrap break-words rounded-[5px] border border-white/[0.08] bg-ink-850 p-2 font-mono text-xs text-mist">
          {event.message}
        </pre>
        <div className="mt-1.5">
          <CopyButton value={event.message} label="copy message" />
        </div>
      </div>
      {event.fields && (
        <div className="mt-4">
          <div className="k-kicker">fields</div>
          <dl className="mt-1 flex flex-col rounded-[5px] border border-white/[0.08] bg-ink-850 font-mono text-xs">
            {leaves.map((leaf) => (
              <FieldRow key={leaf.path.join(".")} leaf={leaf} onFilter={onFilter} />
            ))}
          </dl>
          <details className="mt-2" onToggle={(e) => setRawOpen(e.currentTarget.open)}>
            <summary className="cursor-pointer font-mono text-[10px] text-mist-faint hover:text-mist">
              raw JSON
            </summary>
            {/* Rendered only when open, so its text never duplicates the rows above. */}
            {rawOpen && (
              <pre className="mt-1 overflow-x-auto rounded-[5px] border border-white/[0.08] bg-ink-850 p-2 font-mono text-xs text-mist">
                {JSON.stringify(event.fields, null, 2)}
              </pre>
            )}
          </details>
        </div>
      )}
    </aside>
  );
});

export default EventDrawer;

function leafText(value: JsonValue): string {
  return isString(value) ? value : JSON.stringify(value);
}

/** One field with a button that adds `field.<path>:<value>` to the search. */
function FieldRow({ leaf, onFilter }: { leaf: FieldLeaf; onFilter: (term: string) => void }) {
  const term = fieldFilterTerm(leaf.path, leaf.value);

  return (
    <div className="group flex items-start gap-2 border-b border-white/[0.04] px-2 py-1 last:border-b-0">
      <dt className="w-28 shrink-0 break-all text-mist-faint">{leaf.path.join(".")}</dt>
      <dd className="min-w-0 flex-1 break-all text-mist">{leafText(leaf.value)}</dd>
      {term && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="chip"
              size="icon-xs"
              className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
              onClick={() => onFilter(term)}
              aria-label={`Filter by ${term}`}
            >
              <FilterIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Add {term}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-16 shrink-0 text-mist-faint">{label}</dt>
      <dd className="break-all text-mist">{value}</dd>
    </div>
  );
}
