import { useState } from "react";
import Crown from "./Crown";

export default function TokenGate({ onSave, error }: { onSave: (token: string) => void; error?: string }) {
  const [value, setValue] = useState("");

  const submit = (): void => {
    if (value.trim()) onSave(value);
  };

  return (
    <div className="relative flex h-screen items-center justify-center bg-ink-950 px-4">
      <div className="k-bg-grid absolute inset-0" aria-hidden="true" />
      <div className="k-window relative w-[26rem]">
        <div className="flex items-center gap-3 border-b border-white/[0.08] px-4 py-3">
          <div className="flex gap-1.5" aria-hidden="true">
            <span className="h-2 w-2 rounded-full bg-[#2c3136]" />
            <span className="h-2 w-2 rounded-full bg-[#2c3136]" />
            <span className="h-2 w-2 rounded-full bg-[#4a5c50]" />
          </div>
          <span className="font-mono text-[10px] text-mist-faint">
            kinglet <span className="text-mist-dim">/</span> enter token
          </span>
          <span className="ml-auto flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-gold">
            <span className="k-live-dot" /> live
          </span>
        </div>
        <div className="px-6 py-7">
          <Crown className="h-9 w-9 text-gold" />
          <h1 className="font-display mt-3 text-xl font-bold tracking-wide text-mist">KINGLET</h1>
          <p className="mt-1 font-mono text-xs text-mist-dim">small. light. king.</p>
          <label className="mt-6 block font-mono text-[10px] uppercase tracking-[0.12em] text-mist-faint">
            ingest token
          </label>
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder="tok_…"
            autoFocus
            className="mt-2 w-full rounded-[5px] border border-white/[0.08] bg-ink-900 px-3 py-2.5 font-mono text-sm text-mist outline-none transition-colors focus:border-gold/40"
          />
          {error && <p className="mt-2 font-mono text-xs text-coral">{error}</p>}
          <button
            onClick={submit}
            disabled={!value.trim()}
            className="k-btn k-btn-primary mt-4 w-full justify-center disabled:opacity-40"
          >
            Enter <span aria-hidden="true">↗</span>
          </button>
          <p className="mt-4 font-mono text-[11px] leading-relaxed text-mist-faint">
            Find the token in your server console, or in{" "}
            <span className="text-mist-dim">kinglet.token</span> next to the database file.
          </p>
        </div>
      </div>
    </div>
  );
}
