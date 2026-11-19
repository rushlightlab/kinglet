import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchEvents,
  fetchHistogram,
  fetchServices,
  openStream,
  UnauthorizedError,
} from "../api";
import { useApp } from "../app-context";
import type { Histogram, KingletEvent, Service } from "../types";
import EventDrawer from "../components/EventDrawer";
import FilterBar from "../components/FilterBar";
import HistogramChart from "../components/Histogram";
import LogControls from "../components/LogControls";
import LogTable from "../components/LogTable";
import SiteHeader from "../components/SiteHeader";
import {
  DEFAULT_WINDOW_KEY,
  recommendedRefreshKey,
  refreshMsFor,
  WINDOWS,
} from "../time";
import type { RefreshKey } from "../time";

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>) => ({
    q: typeof search.q === "string" ? search.q.slice(0, 500) : undefined,
    from: Number.isFinite(Number(search.from)) && Number(search.from) > 0 ? Number(search.from) : undefined,
    to: Number.isFinite(Number(search.to)) && Number(search.to) > 0 ? Number(search.to) : undefined,
  }),
  component: Explorer,
});

function Explorer() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const { currentProjectId } = useApp();

  const [qDraft, setQDraft] = useState(() => search.q ?? "");
  const [q, setQ] = useState(() => search.q ?? "");
  const [rangeKey, setRangeKey] = useState(DEFAULT_WINDOW_KEY);
  const [refreshKey, setRefreshKey] = useState<RefreshKey>("off");
  const [customRange, setCustomRange] = useState<null | { from: number; to: number }>(() =>
    search.from !== undefined && search.to !== undefined ? { from: search.from, to: search.to } : null
  );
  const [events, setEvents] = useState<KingletEvent[]>([]);
  const [histogram, setHistogram] = useState<Histogram | null>(null);
  const [services, setServices] = useState<Service[]>([]);
  const [selected, setSelected] = useState<KingletEvent | null>(null);
  const [cursorId, setCursorId] = useState<number | null>(null);
  const [live, setLive] = useState(true);
  const [follow, setFollow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const windowMs = customRange
    ? customRange.to - customRange.from
    : WINDOWS[rangeKey] ?? 60 * 60_000;
  const refreshMs = refreshMsFor(refreshKey);

  const scrollRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const followRef = useRef(true);

  // Debounce the filter bar into the applied query.
  useEffect(() => {
    const t = setTimeout(() => setQ(qDraft), 300);
    return () => clearTimeout(t);
  }, [qDraft]);

  const loadRange = useCallback(
    async (from: number, to: number, silent = false) => {
      if (!silent) setBusy(true);
      try {
        const [page, hist] = await Promise.all([
          fetchEvents({ projectId: currentProjectId, q, from, to, limit: 500 }),
          fetchHistogram({ projectId: currentProjectId, from, to, buckets: 90 }),
        ]);
        setEvents(page.events);
        setHistogram(hist);
        setError(null);
      } catch (err) {
        if (err instanceof UnauthorizedError) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!silent) setBusy(false);
      }
    },
    [q, currentProjectId]
  );

  const loadWindow = useCallback(
    (silent = false) => {
      if (customRange) {
        void loadRange(customRange.from, customRange.to, silent);
        return;
      }
      const to = Date.now();
      const width = WINDOWS[rangeKey] ?? 60 * 60_000;
      void loadRange(to - width, to, silent);
    },
    [customRange, rangeKey, loadRange]
  );

  // Reload when the query, time window, or project changes.
  useEffect(() => {
    loadWindow();
  }, [loadWindow]);

  // Services list for the header.
  useEffect(() => {
    fetchServices(currentProjectId)
      .then((r) => setServices(r.services))
      .catch(() => undefined);
  }, [currentProjectId]);

  // Keep a ref for the SSE closure.
  useEffect(() => {
    followRef.current = follow;
  }, [follow]);

  const toggleLive = useCallback(() => {
    setLive((current) => !current);
  }, []);

  // Refresh is separate from the live tail: it re-queries the window at the
  // selected rate. Off means events arrive only through SSE or manual refresh.
  useEffect(() => {
    if (refreshMs === null) return;
    const id = setInterval(() => loadWindow(true), refreshMs);
    return () => clearInterval(id);
  }, [loadWindow, refreshMs]);

  // Live tail over SSE (session cookie auth).
  useEffect(() => {
    if (!live) return;
    const es = openStream(currentProjectId, q);
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
  }, [live, q, currentProjectId]);

  // Keep the filter in the URL (without clobbering a shared range).
  useEffect(() => {
    if (search.q === (q || undefined)) return;
    void navigate({
      to: "/",
      search: { q: q || undefined, from: undefined, to: undefined },
      replace: true,
    });
  }, [q, navigate, search.q]);

  // Keyboard: / focus filter, j/k move, Esc close, l live, f follow.
  const move = useCallback(
    (delta: number) => {
      const idx = cursorId === null ? -1 : events.findIndex((e) => e.id === cursorId);
      const next = Math.min(events.length - 1, Math.max(0, idx + delta));
      const event = events[next];
      if (!event) return;
      setCursorId(event.id);
      setSelected(event);
    },
    [cursorId, events]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement;
      if (typing) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case "/":
          e.preventDefault();
          filterRef.current?.focus();
          break;
        case "j":
        case "ArrowDown":
          e.preventDefault();
          move(1);
          break;
        case "k":
        case "ArrowUp":
          e.preventDefault();
          move(-1);
          break;
        case "Escape":
          setSelected(null);
          break;
        case "l":
          toggleLive();
          break;
        case "f":
          setFollow((v) => !v);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move, toggleLive]);

  // Apply a full query immediately (chips, saved searches).
  const applyQuery = useCallback((nextQ: string) => {
    setQDraft(nextQ);
    setQ(nextQ);
  }, []);

  // Freeze the current view into a shareable URL and copy it.
  const copyLink = useCallback(() => {
    const now = Date.now();
    const cur = customRange ?? { from: now - (WINDOWS[rangeKey] ?? 60 * 60_000), to: now };
    const url = new URL(window.location.origin + "/");
    url.searchParams.set("project", String(currentProjectId));
    if (q) url.searchParams.set("q", q);
    url.searchParams.set("from", String(cur.from));
    url.searchParams.set("to", String(cur.to));
    void navigate({
      to: "/",
      search: { q: q || undefined, from: cur.from, to: cur.to },
      replace: true,
    });
    void navigator.clipboard?.writeText(url.toString());
  }, [navigate, q, rangeKey, customRange, currentProjectId]);

  return (
    <div className="flex h-screen flex-col bg-ink-950 text-mist">
      <SiteHeader>
        <LogControls
          rangeKey={rangeKey}
          windowMs={windowMs}
          refreshKey={refreshKey}
          customRange={customRange}
          onRangeChange={(value) => {
            const width = WINDOWS[value] ?? 60 * 60_000;
            setRangeKey(value);
            setCustomRange(null);
            if (refreshKey !== "off") setRefreshKey(recommendedRefreshKey(width));
          }}
          onCustomRange={(range) => {
            setCustomRange(range);
            if (refreshKey !== "off") {
              setRefreshKey(recommendedRefreshKey(range.to - range.from));
            }
          }}
          onClearCustom={() => setCustomRange(null)}
          onRefreshChange={setRefreshKey}
          live={live}
          follow={follow}
          onToggleLive={toggleLive}
          onToggleFollow={() => setFollow((v) => !v)}
          services={services}
          appliedQ={q}
          onApplyQuery={applyQuery}
        />
      </SiteHeader>

      <FilterBar
        value={qDraft}
        onChange={setQDraft}
        onEnter={() => setQ(qDraft)}
        onRefresh={loadWindow}
        onCopyLink={copyLink}
        appliedQ={q}
        onApplyQuery={applyQuery}
        count={events.length}
        busy={busy}
        error={error}
        inputRef={filterRef}
      />

      {histogram && (
        <HistogramChart
          data={histogram}
          onSelectRange={(from, to) => setCustomRange({ from, to })}
        />
      )}

      <div className="relative flex-1 overflow-hidden">
        <LogTable
          events={events}
          scrollRef={scrollRef}
          onSelect={setSelected}
          selectedId={selected?.id ?? null}
          cursorId={cursorId}
        />
        {selected && <EventDrawer event={selected} onClose={() => setSelected(null)} />}
      </div>
    </div>
  );
}
