import { useState } from "react";
import Crown from "./Crown";

export default function TokenGate({ onSave, error }: { onSave: (token: string) => void; error?: string }) {
  const [value, setValue] = useState("");

  const submit = (): void => {
    if (value.trim()) onSave(value);
  };

  return (
    <div className="flex h-screen items-center justify-center bg-[#0b0e14] px-4">
      <div className="w-96 rounded-xl border border-[#1c2230] bg-[#0e1119] p-8 text-[#e6e9ef]">
        <Crown className="h-10 w-10" />
        <h1 className="mt-3 text-xl font-semibold">Kinglet</h1>
        <p className="mt-1 text-sm text-[#8b93a3]">Small. Light. King.</p>
        <label className="mt-6 block text-xs text-[#8b93a3]">Ingest token</label>
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="tok_…"
          autoFocus
          className="mt-1 w-full rounded-md border border-[#1c2230] bg-[#11151f] px-3 py-2 font-mono text-sm outline-none focus:border-amber-500/50"
        />
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
        <button
          onClick={submit}
          disabled={!value.trim()}
          className="mt-4 w-full rounded-md bg-amber-500 px-3 py-2 text-sm font-semibold text-black hover:bg-amber-400 disabled:opacity-40"
        >
          Enter
        </button>
        <p className="mt-4 text-[11px] leading-relaxed text-[#8b93a3]">
          Find the token in your server console, or in{" "}
          <code className="text-[#a8b3c7]">kinglet.token</code> next to the database file.
        </p>
      </div>
    </div>
  );
}
