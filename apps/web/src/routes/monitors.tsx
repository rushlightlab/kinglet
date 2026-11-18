import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import {
  createMonitor,
  deleteMonitor,
  fetchAlerts,
  fetchMonitors,
  testMonitor,
  updateMonitor,
} from "../api";
import { useApp } from "../app-context";
import type { AlertRecord, Monitor, MonitorKind, NotifyChannel } from "../types";
import SiteHeader from "../components/SiteHeader";

export const Route = createFileRoute("/monitors")({
  component: MonitorsPage,
});

const KIND_LABELS: Record<MonitorKind, string> = {
  match: "instant match",
  count_above: "spike",
  count_below: "silence",
};

const CHANNEL_PLACEHOLDERS: Record<NotifyChannel["type"], string> = {
  webhook: "https://your-endpoint.example/hook",
  discord: "https://discord.com/api/webhooks/…",
  slack: "https://hooks.slack.com/services/…",
};

function fmtDur(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function describe(m: Monitor): string {
  if (m.kind === "match") return "Fires the instant an event matches.";
  if (m.kind === "count_above")
    return `Fires when more than ${m.threshold} matching events land within ${fmtDur(m.windowMs)}.`;
  return `Fires when fewer than ${m.threshold} matching events land within ${fmtDur(m.windowMs)} — silence means something broke.`;
}

function MonitorsPage() {
  const { currentProjectId } = useApp();
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [testMsg, setTestMsg] = useState<Record<number, string>>({});

  const load = useCallback(async () => {
    try {
      const [m, a] = await Promise.all([fetchMonitors(currentProjectId), fetchAlerts(currentProjectId, 50)]);
      setMonitors(m.monitors);
      setAlerts(a.alerts);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [currentProjectId]);

  useEffect(() => {
    setEditing(null);
    void load();
  }, [load]);

  const toggleEnabled = async (m: Monitor): Promise<void> => {
    try {
      await updateMonitor(currentProjectId, m.id, { ...m, enabled: !m.enabled });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (id: number): Promise<void> => {
    try {
      await deleteMonitor(currentProjectId, id);
      setConfirmDelete(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const runTest = async (m: Monitor): Promise<void> => {
    setTestMsg((prev) => ({ ...prev, [m.id]: "testing…" }));
    try {
      const r = await testMonitor(currentProjectId, m.id);
      const ok = r.results.filter((x) => x.ok).length;
      const text =
        r.results.length === 0
          ? "no channels configured"
          : ok === r.results.length
            ? `✓ sent to ${ok} channel${ok === 1 ? "" : "s"}`
            : r.results.map((x) => (x.ok ? `✓ ${x.type}` : `✗ ${x.type}: ${x.error ?? "failed"}`)).join("  ·  ");
      setTestMsg((prev) => ({ ...prev, [m.id]: text }));
    } catch (err) {
      setTestMsg((prev) => ({ ...prev, [m.id]: err instanceof Error ? err.message : "test failed" }));
    }
    setTimeout(() => {
      setTestMsg((prev) => {
        const next = { ...prev };
        delete next[m.id];
        return next;
      });
    }, 8000);
  };

  const editingMonitor = typeof editing === "number" ? monitors.find((m) => m.id === editing) ?? null : null;

  return (
    <div className="flex h-screen flex-col bg-ink-950 text-mist">
      <SiteHeader>
        <button onClick={() => void load()} className="k-chip-btn" title="Refresh">
          ↻
        </button>
      </SiteHeader>

      <main className="relative flex-1 overflow-y-auto">
        <div className="k-bg-grid absolute inset-0" aria-hidden="true" />
        <div className="relative mx-auto w-full max-w-3xl px-6 py-8">
          <div className="k-kicker">
            <span className="text-gold">/</span> monitors
          </div>
          <h1 className="font-display mt-2 text-2xl font-bold tracking-wide">Alerts on your terms.</h1>
          <p className="mt-2 max-w-lg font-mono text-xs leading-relaxed text-mist-dim">
            Get notified when logs match a query — or when expected logs go missing.
            Channels are plain webhook URLs: anything that accepts a POST works.
          </p>

          {error && (
            <p className="mt-4 rounded-[5px] border border-coral/25 bg-coral/[0.05] px-3 py-2 font-mono text-xs text-coral">
              {error}
            </p>
          )}

          <div className="mt-6 flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-mist-faint">
              {monitors.length} monitor{monitors.length === 1 ? "" : "s"}
            </span>
            <button onClick={() => setEditing("new")} className="k-btn k-btn-primary k-btn-sm">
              + new monitor
            </button>
          </div>

          {(editing === "new" || editingMonitor) && (
            <MonitorForm
              key={editing === "new" ? "new" : `edit-${editing}`}
              initial={editingMonitor}
              projectId={currentProjectId}
              onDone={async () => {
                setEditing(null);
                await load();
              }}
              onCancel={() => setEditing(null)}
            />
          )}

          <div className="mt-4 flex flex-col gap-3">
            {monitors.map((m) => (
              <article key={m.id} className={`k-card p-4 ${m.enabled ? "" : "opacity-60"}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-display truncate text-[15px] font-semibold tracking-wide">{m.name}</h3>
                      <span className="rounded-[3px] border border-gold/25 bg-gold/[0.06] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-gold">
                        {KIND_LABELS[m.kind]}
                      </span>
                      {!m.enabled && (
                        <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-mist-faint">
                          paused
                        </span>
                      )}
                      {m.lastError && (
                        <span
                          title={m.lastError}
                          className="rounded-[3px] border border-coral/30 bg-coral/[0.06] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-coral"
                        >
                          degraded
                        </span>
                      )}
                    </div>
                    <p className="mt-1.5 font-mono text-xs text-mist-dim">{describe(m)}</p>
                    <code className="mt-2 inline-block max-w-full truncate rounded-[3px] border border-white/[0.08] bg-ink-850 px-2 py-1 font-mono text-[11px] text-mist">
                      {m.query || "(all events)"}
                    </code>
                    <p className="mt-2 font-mono text-[10px] text-mist-faint">
                      checked every {fmtDur(m.kind === "match" ? 0 : m.intervalMs)}
                      {m.kind !== "match" && ` · cooldown ${fmtDur(m.cooldownMs)}`} ·{" "}
                      {m.channels.length === 0
                        ? "no channels (history only)"
                        : `${m.channels.length} channel${m.channels.length === 1 ? "" : "s"}`}
                    </p>
                    {testMsg[m.id] && (
                      <p className="mt-2 font-mono text-[11px] text-gold">{testMsg[m.id]}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      onClick={() => void toggleEnabled(m)}
                      role="switch"
                      aria-checked={m.enabled}
                      title={m.enabled ? "Pause" : "Enable"}
                      className={`relative h-5 w-9 rounded-full border transition-colors ${
                        m.enabled ? "border-gold/40 bg-gold/20" : "border-white/[0.08] bg-white/[0.03]"
                      }`}
                    >
                      <span
                        className={`absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full transition-all ${
                          m.enabled ? "left-[18px] bg-gold" : "left-1 bg-mist-faint"
                        }`}
                      />
                    </button>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-3">
                  <button onClick={() => void runTest(m)} className="k-chip-btn" title="Send a test notification">
                    test
                  </button>
                  <button onClick={() => setEditing(m.id)} className="k-chip-btn">
                    edit
                  </button>
                  {confirmDelete === m.id ? (
                    <>
                      <button onClick={() => void remove(m.id)} className="k-chip-btn border-coral/40 text-coral">
                        confirm delete
                      </button>
                      <button onClick={() => setConfirmDelete(null)} className="k-chip-btn">
                        cancel
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(m.id)}
                      className="k-chip-btn hover:!border-coral/35 hover:!text-coral"
                    >
                      delete
                    </button>
                  )}
                </div>
              </article>
            ))}

            {monitors.length === 0 && editing === null && (
              <div className="k-card flex flex-col items-center gap-3 px-4 py-10 text-center">
                <p className="font-mono text-xs text-mist-dim">No monitors yet.</p>
                <p className="font-mono text-[11px] text-mist-faint">
                  Watch for <span className="text-gold">level:fatal</span>, spike rates, or a cron that went quiet.
                </p>
                <button onClick={() => setEditing("new")} className="k-btn k-btn-primary k-btn-sm mt-1">
                  Create your first monitor
                </button>
              </div>
            )}
          </div>

          <div className="mt-14">
            <div className="k-kicker">
              <span className="text-gold">/</span> alerts
            </div>
            <h2 className="font-display mt-2 text-lg font-semibold tracking-wide">Recent alerts</h2>
            <div className="mt-3">
              {alerts.map((a) => (
                <div key={a.id} className="flex items-center gap-3 border-b border-white/[0.04] py-2.5 font-mono text-xs">
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      a.state === "fired" && a.resolvedAt === null ? "bg-coral" : "bg-gold"
                    }`}
                  />
                  <span className="w-24 shrink-0 text-mist-faint">{relTime(a.firedAt)}</span>
                  <span className="w-36 shrink-0 truncate text-mist-dim">{a.monitorName ?? "monitor"}</span>
                  <span className="truncate text-mist">{a.summary}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-2">
                    {a.state === "fired" && a.notifyStatus && a.notifyStatus !== "none" && (
                      <span
                        title={a.notifyError ?? "Notification delivery"}
                        className={`text-[10px] uppercase tracking-[0.12em] ${
                          a.notifyStatus === "sent"
                            ? "text-mist-faint"
                            : a.notifyStatus === "partial"
                              ? "text-gold"
                              : "text-coral"
                        }`}
                      >
                        notify {a.notifyStatus}
                      </span>
                    )}
                    {a.state === "fired" && a.resolvedAt === null ? (
                      <span className="text-[10px] uppercase tracking-[0.12em] text-coral">fired</span>
                    ) : (
                      <span className="text-[10px] uppercase tracking-[0.12em] text-gold-dim">
                        resolved
                      </span>
                    )}
                  </span>
                </div>
              ))}
              {alerts.length === 0 && (
                <p className="py-6 font-mono text-xs text-mist-faint">
                  No alerts yet. When a monitor fires, its story lands here.
                </p>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

// ---------- form ----------

interface FormState {
  name: string;
  query: string;
  kind: MonitorKind;
  threshold: number;
  windowMin: number;
  intervalSec: number;
  cooldownMin: number;
  channels: NotifyChannel[];
}

function MonitorForm({
  initial,
  projectId,
  onDone,
  onCancel,
}: {
  initial: Monitor | null;
  projectId: number;
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<FormState>(() => ({
    name: initial?.name ?? "",
    query: initial?.query ?? "",
    kind: initial?.kind ?? "count_above",
    threshold: initial?.threshold ?? 10,
    windowMin: initial ? Math.max(1, Math.round(initial.windowMs / 60_000)) : 5,
    intervalSec: initial ? Math.max(10, Math.round(initial.intervalMs / 1000)) : 60,
    cooldownMin: initial ? Math.max(0, Math.round(initial.cooldownMs / 60_000)) : 10,
    channels: initial?.channels ?? [],
  }));
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const setChannel = (index: number, patch: Partial<NotifyChannel>): void => {
    setForm((prev) => ({
      ...prev,
      channels: prev.channels.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    }));
  };

  const save = async (): Promise<void> => {
    if (!form.name.trim()) {
      setFormError("Give the monitor a name.");
      return;
    }
    const channels = form.channels.filter((c) => c.url.trim());
    if (channels.some((c) => !/^https?:\/\//i.test(c.url.trim()))) {
      setFormError("Channel URLs must start with http:// or https://");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const payload = {
        name: form.name.trim(),
        query: form.query.trim(),
        kind: form.kind,
        threshold: form.threshold,
        windowMs: Math.round(form.windowMin * 60_000),
        intervalMs: Math.round(form.intervalSec * 1000),
        cooldownMs: Math.round(form.cooldownMin * 60_000),
        enabled: true,
        channels,
      };
      if (initial) await updateMonitor(projectId, initial.id, payload);
      else await createMonitor(projectId, payload);
      await onDone();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const isCount = form.kind !== "match";

  return (
    <div className="k-card mt-4 border-gold/20 p-5">
      <div className="k-kicker">{initial ? `edit monitor / ${initial.name}` : "new monitor"}</div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-mist-faint">name</span>
          <input
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="payment errors"
            className="mt-1 w-full rounded-[5px] border border-white/[0.08] bg-ink-900 px-3 py-2 font-mono text-xs text-mist outline-none transition-colors focus:border-gold/40"
          />
        </label>

        <label className="block sm:col-span-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-mist-faint">
            query — same grammar as the log view
          </span>
          <input
            value={form.query}
            onChange={(e) => set("query", e.target.value)}
            placeholder={`level>=error service:billing`}
            spellCheck={false}
            className="mt-1 w-full rounded-[5px] border border-white/[0.08] bg-ink-900 px-3 py-2 font-mono text-xs text-mist outline-none transition-colors focus:border-gold/40"
          />
        </label>

        <label className="block">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-mist-faint">condition</span>
          <select
            value={form.kind}
            onChange={(e) => set("kind", e.target.value as MonitorKind)}
            className="mt-1 w-full cursor-pointer rounded-[5px] border border-white/[0.08] bg-ink-900 px-3 py-2 font-mono text-xs text-mist outline-none transition-colors focus:border-gold/40"
          >
            <option value="match">instant match — any event fires</option>
            <option value="count_above">spike — more than N in a window</option>
            <option value="count_below">silence — fewer than N in a window</option>
          </select>
        </label>

        {isCount && (
          <label className="block">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-mist-faint">threshold</span>
            <input
              type="number"
              min={1}
              value={form.threshold}
              onChange={(e) => set("threshold", Math.max(1, Math.trunc(Number(e.target.value)) || 1))}
              className="mt-1 w-full rounded-[5px] border border-white/[0.08] bg-ink-900 px-3 py-2 font-mono text-xs text-mist outline-none transition-colors focus:border-gold/40"
            />
          </label>
        )}

        {isCount && (
          <label className="block">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-mist-faint">window (minutes)</span>
            <input
              type="number"
              min={1}
              value={form.windowMin}
              onChange={(e) => set("windowMin", Math.max(1, Math.trunc(Number(e.target.value)) || 1))}
              className="mt-1 w-full rounded-[5px] border border-white/[0.08] bg-ink-900 px-3 py-2 font-mono text-xs text-mist outline-none transition-colors focus:border-gold/40"
            />
          </label>
        )}

        {isCount && (
          <label className="block">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-mist-faint">
              check every (seconds)
            </span>
            <input
              type="number"
              min={10}
              value={form.intervalSec}
              onChange={(e) => set("intervalSec", Math.max(10, Math.trunc(Number(e.target.value)) || 60))}
              className="mt-1 w-full rounded-[5px] border border-white/[0.08] bg-ink-900 px-3 py-2 font-mono text-xs text-mist outline-none transition-colors focus:border-gold/40"
            />
          </label>
        )}

        <label className="block">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-mist-faint">
            cooldown (minutes)
          </span>
          <input
            type="number"
            min={0}
            value={form.cooldownMin}
            onChange={(e) => set("cooldownMin", Math.max(0, Math.trunc(Number(e.target.value)) || 0))}
            className="mt-1 w-full rounded-[5px] border border-white/[0.08] bg-ink-900 px-3 py-2 font-mono text-xs text-mist outline-none transition-colors focus:border-gold/40"
          />
        </label>
      </div>

      <div className="mt-5">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-mist-faint">channels</span>
        <div className="mt-2 flex flex-col gap-2">
          {form.channels.map((c, i) => (
            <div key={i} className="flex flex-wrap gap-2">
              <select
                value={c.type}
                onChange={(e) => setChannel(i, { type: e.target.value as NotifyChannel["type"] })}
                className="cursor-pointer rounded-[5px] border border-white/[0.08] bg-ink-900 px-2 py-2 font-mono text-xs text-mist outline-none focus:border-gold/40"
              >
                <option value="webhook">webhook</option>
                <option value="discord">discord</option>
                <option value="slack">slack</option>
              </select>
              <input
                value={c.url}
                onChange={(e) => setChannel(i, { url: e.target.value })}
                placeholder={CHANNEL_PLACEHOLDERS[c.type]}
                spellCheck={false}
                className="min-w-0 flex-1 rounded-[5px] border border-white/[0.08] bg-ink-900 px-3 py-2 font-mono text-xs text-mist outline-none transition-colors focus:border-gold/40"
              />
              <button
                onClick={() => set("channels", form.channels.filter((_, j) => j !== i))}
                className="k-chip-btn"
                title="Remove channel"
              >
                ✕
              </button>
            </div>
          ))}
          <button
            onClick={() => set("channels", [...form.channels, { type: "webhook", url: "" }])}
            className="k-chip-btn self-start"
          >
            + channel
          </button>
        </div>
      </div>

      {formError && <p className="mt-4 font-mono text-xs text-coral">{formError}</p>}

      <div className="mt-5 flex items-center gap-2 border-t border-white/[0.06] pt-4">
        <button onClick={() => void save()} disabled={saving} className="k-btn k-btn-primary k-btn-sm disabled:opacity-40">
          {saving ? "saving…" : initial ? "Save changes" : "Create monitor"}
        </button>
        <button onClick={onCancel} className="k-btn k-btn-ghost k-btn-sm">
          Cancel
        </button>
      </div>
    </div>
  );
}
