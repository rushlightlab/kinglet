import type { KingletEvent } from "../types";
import { LevelBadge } from "./LevelBadge";

export default function EventDrawer({ event, onClose }: { event: KingletEvent; onClose: () => void }) {
  return (
    <aside className="absolute right-0 top-0 z-10 flex h-full w-[26rem] flex-col overflow-y-auto border-l border-[#1c2230] bg-[#0e1119] p-4">
      <div className="flex items-center justify-between">
        <LevelBadge level={event.level} />
        <button onClick={onClose} className="rounded-md px-1 text-[#8b93a3] hover:bg-[#11151f] hover:text-[#e6e9ef]">
          ✕
        </button>
      </div>
      <dl className="mt-4 space-y-2 text-xs">
        <Row label="time" value={new Date(event.ts).toISOString()} />
        <Row label="service" value={event.service ?? "—"} />
        <Row label="env" value={event.env ?? "—"} />
        <Row label="id" value={String(event.id)} />
      </dl>
      <div className="mt-4">
        <div className="mb-1 text-[10px] uppercase tracking-widest text-[#8b93a3]">message</div>
        <pre className="whitespace-pre-wrap break-words rounded-md border border-[#1c2230] bg-[#11151f] p-2 font-mono text-xs">
          {event.message}
        </pre>
        <button
          onClick={() => void navigator.clipboard?.writeText(event.message)}
          className="mt-1 text-[10px] text-[#8b93a3] hover:text-[#e6e9ef]"
        >
          copy message
        </button>
      </div>
      {event.fields && (
        <div className="mt-4">
          <div className="mb-1 text-[10px] uppercase tracking-widest text-[#8b93a3]">fields</div>
          <pre className="overflow-x-auto rounded-md border border-[#1c2230] bg-[#11151f] p-2 font-mono text-xs">
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
      <dt className="w-16 shrink-0 text-[#8b93a3]">{label}</dt>
      <dd className="break-all font-mono">{value}</dd>
    </div>
  );
}
