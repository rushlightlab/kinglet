import { useState } from "react";
import { login } from "../api";
import Crown from "./Crown";

export default function Login({ onSuccess, error: initialError }: { onSuccess: () => void; error?: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (!email.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "sign in failed");
      setBusy(false);
    }
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
            kinglet <span className="text-mist-dim">/</span> sign in
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
            email
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
            autoComplete="username"
            placeholder="admin@kinglet.local"
            className="mt-2 w-full rounded-[5px] border border-white/[0.08] bg-ink-900 px-3 py-2.5 font-mono text-sm text-mist outline-none transition-colors focus:border-gold/40"
          />

          <label className="mt-4 block font-mono text-[10px] uppercase tracking-[0.12em] text-mist-faint">
            password
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
            autoComplete="current-password"
            placeholder="••••••••"
            className="mt-2 w-full rounded-[5px] border border-white/[0.08] bg-ink-900 px-3 py-2.5 font-mono text-sm text-mist outline-none transition-colors focus:border-gold/40"
          />

          {error && <p className="mt-3 font-mono text-xs text-coral">{error}</p>}

          <button
            onClick={() => void submit()}
            disabled={busy || !email.trim() || !password}
            className="k-btn k-btn-primary mt-5 w-full justify-center disabled:opacity-40"
          >
            {busy ? "signing in…" : "Sign in"} {!busy && <span aria-hidden="true">↗</span>}
          </button>

          <p className="mt-4 font-mono text-[11px] leading-relaxed text-mist-faint">
            No administrator yet? The generated password is in the server console or{" "}
            <span className="text-mist-dim">admin-password.txt</span> next to a local database.
          </p>
        </div>
      </div>
    </div>
  );
}
