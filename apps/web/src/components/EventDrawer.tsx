import type { KingletEvent } from "../types";
import { LevelBadge } from "./LevelBadge";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import CopyButton from "./CopyButton";

export default function EventDrawer({ event, onClose }: { event: KingletEvent; onClose: () => void }) {
  return (
    <aside className="absolute right-0 top-0 z-10 flex h-full w-[26rem] flex-col overflow-y-auto border-l border-white/[0.08] bg-ink-900 p-4">
      <div className="flex items-center justify-between">
        <LevelBadge level={event.level} />
        <Button variant="chip" size="icon-xs" onClick={onClose} title="Close (Esc)" aria-label="Close">
          <XIcon />
        </Button>
      </div>
      <dl className="mt-4 flex flex-col gap-2 font-mono text-xs">
        <Row label="time" value={new Date(event.ts).toISOString()} />
        <Row label="service" value={event.service ?? "—"} />
        <Row label="env" value={event.env ?? "—"} />
        <Row label="api key" value={event.apiKeyId ? `#${event.apiKeyId}` : "session"} />
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
          <pre className="mt-1 overflow-x-auto rounded-[5px] border border-white/[0.08] bg-ink-850 p-2 font-mono text-xs text-mist">
            {JSON.stringify(event.fields, null, 2)}
          </pre>
        </div>
      )}
    </aside>
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
