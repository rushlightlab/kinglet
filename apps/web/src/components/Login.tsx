import { useState } from "react";
import { ArrowUpRightIcon } from "lucide-react";
import { login } from "../api";
import Crown from "./Crown";
import ErrorAlert from "./ErrorAlert";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import PasswordInput from "./PasswordInput";

export default function Login({
  onSuccess,
  error: initialError,
}: {
  onSuccess: () => void;
  error?: string;
}) {
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
            <span className="size-2 rounded-full bg-[#2c3136]" />
            <span className="size-2 rounded-full bg-[#2c3136]" />
            <span className="size-2 rounded-full bg-[#4a5c50]" />
          </div>
          <span className="font-mono text-[10px] text-mist-faint">
            kinglet <span className="text-mist-dim">/</span> sign in
          </span>
          <span className="ml-auto flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-gold">
            <span className="k-live-dot" /> live
          </span>
        </div>
        <div className="px-6 py-7">
          <Crown className="size-9 text-gold" />
          <h1 className="font-display mt-3 text-xl font-bold tracking-wide text-mist">KINGLET</h1>
          <p className="mt-1 font-mono text-xs text-mist-dim">small. light. king.</p>

          <FieldGroup className="mt-6">
            <Field>
              <FieldLabel htmlFor="email">email</FieldLabel>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoFocus
                autoComplete="username"
                placeholder="admin@kinglet.local"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="password">password</FieldLabel>
              <PasswordInput
                id="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submit();
                }}
                autoComplete="current-password"
                placeholder="••••••••"
              />
            </Field>
          </FieldGroup>

          {error && (
            <div className="mt-3">
              <ErrorAlert error={error} />
            </div>
          )}

          <Button
            onClick={() => void submit()}
            disabled={busy || !email.trim() || !password}
            className="mt-5 w-full"
          >
            {busy ? (
              <>
                <Spinner data-icon="inline-start" />
                signing in…
              </>
            ) : (
              <>
                Sign in
                <ArrowUpRightIcon data-icon="inline-end" />
              </>
            )}
          </Button>

          <p className="mt-4 font-mono text-[11px] leading-relaxed text-mist-faint">
            No administrator yet? The generated password is in the server console or{" "}
            <span className="text-mist-dim">admin-password.txt</span> next to a local database.
          </p>
        </div>
      </div>
    </div>
  );
}
