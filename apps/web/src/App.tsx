import { useCallback, useEffect, useRef, useState } from "react";
import {
  clearToken,
  fetchEvents,
  fetchHistogram,
  fetchServices,
  getToken,
  openStream,
  setToken,
  sprayDemoEvents,
  UnauthorizedError,
} from "./api";
import type { Histogram, KingletEvent, Service } from "./types";
import EventDrawer from "./components/EventDrawer";
import FilterBar from "./components/FilterBar";
import HistogramChart from "./components/Histogram";
import LogTable from "./components/LogTable";
import TokenGate from "./components/TokenGate";
import Crown from "./components/Crown";

const WINDOWS: Record<string, number> = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
};

export default function App() {
  const [token, setTokenState] = useState<string | null>(() => getToken());

  if (!token) {
    return (
      <TokenGate
        onSave={(t) => {
          setToken(t);
          setTokenState(t);
        }}
      />
    );
  }

  return <Explorer onSignOut={() => { clearToken(); setTokenState(null); }} />;
}

function Explorer({ onSignOut }: { onSignOut: () => void }) {
  const [qDraft, setQDraft] = useState("");
  const [q, setQ] = useState("");
  const [rangeKey, setRangeKey] = useState("1h");
  const [events, setEvents] = useState<KingletEvent[]>([]);
  const [histogram, setHistogram] = useState<Histogram | null>(null);
  const [services, setServices] = useState<Service[]>([]);
  const [selected, setSelected] = useState<KingletEvent | null>(null);
  const [live, setLive] = useState(true);
  const [follow, setFollow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authFailed, setAuthFailed] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  // Debounce the filter bar into the applied query.
  useEffect(() => {
    const t = setTimeout(() => setQ(qDraft), 300);
    return () => clearTimeout(t);
  }, [qDraft]);

  const loadRange = useCallback(
    async (from: number, to: number) => {
      setBusy(true);
      try {
        const [page, hist] = await Promise.all([
          fetchEvents({ q, from, to, limit: 500 }),
          fetchHistogram({ from, to, buckets: 90 }),
        ]);
        setEvents(page.events);
        setHistogram(hist);
        setError(null);
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          setAuthFailed(true);
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [q]
  );

  const loadWindow = useCallback(() => {
    const to = Date.now();
    const width = WINDOWS[rangeKey] ?? 60 * 60_000;
    void loadRange(to - width, to);
  }, [rangeKey, loadRange]);

  // Reload when the query or time window changes.
  useEffect(() => {
    loadWindow();
  }, [loadWindow]);

  // Services list for the header.
  useEffect(() => {
    fetchServices()
      .then((r) => setServices(r.services))
      .catch(() => undefined);
  }, []);

  // Keep a ref for the SSE closure.
  useEffect(() => {
    followRef.current = follow;
  }, [follow]);

  // While live, refresh the window every 15s.
  useEffect(() => {
    if (!live) return;
    const id = setInterval(loadWindow, 15_000);
    return () => clearInterval(id);
  }, [live, loadWindow]);

  // Live tail over SSE.
  useEffect(() => {
    if (!live) return;
    const es = openStream(q);
    es.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as KingletEvent;
        setEvents((prev) => [event, ...prev].slice(0, 5000));
        if (followRef.current && scrollRef.current) {
          scrollRef.current.scrollTo({ top: 0 });
        }
      } catch {
        // ignore malformed frames
      }
    };
    return () => es.close();
  }, [live, q]);

  if (authFailed) {
    return (
      <TokenGate
        error="That token was rejected."
        onSave={(t) => {
          setToken(t);
          setAuthFailed(false);
          loadWindow();
        }}
      />
    );
  }

  return (
    <div className="flex h-screen flex-col bg-[#0b0e14] text-[#e6e9ef]">
      <header className="flex items-center gap-3 border-b border-[#1c2230] px-4 py-2">
        <Crown className="h-5 w-5" />
        <div className="leading-tight">
          <div className="text-sm font-semibold tracking-wide">Kinglet</div>
          <div className="text-[10px] uppercase tracking-widest text-[#8b93a3]">self-hosted logs</div>
        </div>
        <div className="mx-1 h-6 w-px bg-[#1c2230]" />
        <select
          value={rangeKey}
          onChange={(e) => setRangeKey(e.target.value)}
          className="rounded-md border border-[#1c2230] bg-[#11151f] px-2 py-1 text-xs"
          title="Time window"
        >
          {Object.keys(WINDOWS).map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={live}
            onChange={(e) => setLive(e.target.checked)}
            className="accent-amber-400"
          />
          Live
        </label>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-[#8b93a3]">
          <input
            type="checkbox"
            checked={follow}
            disabled={!live}
            onChange={(e) => setFollow(e.target.checked)}
            className="accent-amber-400"
          />
          Follow
        </label>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[11px] text-[#8b93a3]">{services.length} services</span>
          <button
            onClick={() => {
              void sprayDemoEvents().catch((err) => setError(err instanceof Error ? err.message : String(err)));
            }}
            className="rounded-md border border-[#1c2230] px-2 py-1 text-xs hover:bg-[#11151f]"
            title="Generate some noisy demo traffic"
          >
            Spray demo logs
          </button>
          <button
            onClick={onSignOut}
            className="rounded-md px-2 py-1 text-xs text-[#8b93a3] hover:bg-[#11151f] hover:text-[#e6e9ef]"
          >
            Sign out
          </button>
        </div>
      </header>

      <FilterBar
        value={qDraft}
        onChange={setQDraft}
        onEnter={() => setQ(qDraft)}
        onRefresh={loadWindow}
        count={events.length}
        busy={busy}
        error={error}
      />

      {histogram && (
        <HistogramChart data={histogram} onSelectRange={(from, to) => void loadRange(from, to)} />
      )}

      <div className="relative flex-1 overflow-hidden">
        <LogTable events={events} scrollRef={scrollRef} onSelect={setSelected} selectedId={selected?.id ?? null} />
        {selected && <EventDrawer event={selected} onClose={() => setSelected(null)} />}
      </div>
    </div>
  );
}
