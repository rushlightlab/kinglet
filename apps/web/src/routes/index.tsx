import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchEvents,
  fetchFieldVocabulary,
  fetchHistogram,
  fetchServices,
  openStream,
  UnauthorizedError,
} from "../api";
import { useApp } from "../app-context";
import { isString } from "../json";
import { addTerm, EMPTY_VOCABULARY } from "../query";
import type { Vocabulary } from "../query";
import { isKingletEvent } from "../types";
import type { Histogram, KingletEvent, Service } from "../types";
import EventDrawer from "../components/EventDrawer";
import FilterBar from "../components/FilterBar";
import HistogramChart from "../components/Histogram";
import LogControls from "../components/LogControls";
import LogTable from "../components/LogTable";
import SiteHeader from "../components/SiteHeader";
import { DEFAULT_WINDOW_KEY, recommendedRefreshKey, refreshMsFor, WINDOWS } from "../time";
import type { RefreshKey } from "../time";

const VOCABULARY_REFRESH_MS = 5 * 60_000;

export const Route = createFileRoute("/")({
  validateSearch: (search) => ({
    q: isString(search.q) ? search.q.slice(0, 500) : undefined,
    from:
      Number.isFinite(Number(search.from)) && Number(search.from) > 0
        ? Number(search.from)
        : undefined,
    to: Number.isFinite(Number(search.to)) && Number(search.to) > 0 ? Number(search.to) : undefined,
  }),
  component: Explorer,
});

function histogramWithLiveEvent(data: Histogram, event: KingletEvent): Histogram {
  const first = data.points[0];

  if (!first) return data;

  if (event.ts < data.from) return data;

  if (!Number.isInteger(event.level) || event.level < 0 || event.level > 5) return data;

  const bucketTs = Math.floor(event.ts / data.bucketMs) * data.bucketMs;
  let index = Math.round((bucketTs - first.ts) / data.bucketMs);

  if (index < 0) return data;

  // Live events arrive just after the loaded window ended; grow the newest
  // bucket instead of dropping them until the next full refresh.
  if (index >= data.points.length) {
    if (event.ts > data.to + data.bucketMs * 2) return data;
    index = data.points.length - 1;
  }

  const point = data.points[index];

  if (!point) return data;
  const counts = point.counts.slice();

  counts[event.level] = (counts[event.level] ?? 0) + 1;

  const points = data.points.slice();

  points[index] = { ...point, counts };

  return { ...data, points };
}

function Explorer() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const { currentProjectId } = useApp();

  const [qDraft, setQDraft] = useState(() => search.q ?? "");
  const [q, setQ] = useState(() => search.q ?? "");
  const [rangeKey, setRangeKey] = useState(DEFAULT_WINDOW_KEY);
  const [refreshKey, setRefreshKey] = useState<RefreshKey>("off");

  const [customRange, setCustomRange] = useState<null | { from: number; to: number }>(() =>
    search.from !== undefined && search.to !== undefined
      ? { from: search.from, to: search.to }
      : null,
  );

  const [events, setEvents] = useState<KingletEvent[]>([]);
  const [histogram, setHistogram] = useState<Histogram | null>(null);
  const [services, setServices] = useState<Service[]>([]);
  const [vocabulary, setVocabulary] = useState<Vocabulary>(EMPTY_VOCABULARY);
  const [selected, setSelected] = useState<KingletEvent | null>(null);
  const [cursorId, setCursorId] = useState<number | null>(null);
  const [live, setLive] = useState(true);
  const [follow, setFollow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const windowMs = customRange
    ? customRange.to - customRange.from
    : (WINDOWS.get(rangeKey) ?? 60 * 60_000);

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
          fetchHistogram({ projectId: currentProjectId, from, to, buckets: 90, q }),
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
    [q, currentProjectId],
  );

  const loadWindow = useCallback(
    (silent = false) => {
      if (customRange) {
        void loadRange(customRange.from, customRange.to, silent);

        return;
      }

      const to = Date.now();
      const width = WINDOWS.get(rangeKey) ?? 60 * 60_000;
      void loadRange(to - width, to, silent);
    },
    [customRange, rangeKey, loadRange],
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

  // Autocomplete vocabulary from recent events, refreshed every few minutes so
  // new fields show up without a reload.
  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      try {
        const next = await fetchFieldVocabulary(currentProjectId);

        if (!cancelled) setVocabulary(next);
      } catch {
        // Autocomplete is a convenience; the search still works without it.
      }
    };

    setVocabulary(EMPTY_VOCABULARY);
    void load();
    const timer = setInterval(() => void load(), VOCABULARY_REFRESH_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
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

    const onMessage = (msg: MessageEvent): void => {
      try {
        const parsed: unknown = JSON.parse(msg.data);

        if (!isKingletEvent(parsed)) return;
        setEvents((prev) => [parsed, ...prev].slice(0, 5000));
        setHistogram((current) => (current ? histogramWithLiveEvent(current, parsed) : current));

        if (followRef.current && scrollRef.current) {
          scrollRef.current.scrollTo({ top: 0 });
        }
      } catch {
        // ignore malformed frames
      }
    };

    es.addEventListener("message", onMessage);

    return () => {
      es.removeEventListener("message", onMessage);
      es.close();
    };
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
    [cursorId, events],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target instanceof HTMLElement ? e.target : null;

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

  const toggleLevelFilter = useCallback(
    (level: string) => {
      const term = `level:${level}`;
      const parts = q.split(/\s+/).filter(Boolean);
      const withoutLevel = parts.filter((part) => !/^-?level(?:[:<>=]|$)/i.test(part));
      const hasLevel = parts.some((part) => part.toLowerCase() === term);

      applyQuery((hasLevel ? withoutLevel : [...withoutLevel, term]).join(" "));
    },
    [q, applyQuery],
  );

  // Freeze the current view into a shareable URL and copy it.
  const copyLink = useCallback(() => {
    const now = Date.now();
    const cur = customRange ?? { from: now - (WINDOWS.get(rangeKey) ?? 60 * 60_000), to: now };
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

  const clearCustomRange = useCallback(() => {
    setCustomRange(null);

    if (refreshKey !== "off") {
      setRefreshKey(recommendedRefreshKey(WINDOWS.get(rangeKey) ?? 60 * 60_000));
    }
  }, [rangeKey, refreshKey]);

  return (
    <div className="flex h-screen flex-col bg-ink-950 text-mist">
      <SiteHeader>
        <LogControls
          rangeKey={rangeKey}
          windowMs={windowMs}
          refreshKey={refreshKey}
          customRange={customRange}
          onRangeChange={(value) => {
            const width = WINDOWS.get(value) ?? 60 * 60_000;
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
          onClearCustom={clearCustomRange}
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
        vocabulary={vocabulary}
      />

      {histogram && (
        <HistogramChart
          key={`${histogram.from}:${histogram.to}:${q}`}
          data={histogram}
          onSelectRange={(from, to) => {
            setCustomRange({ from, to });

            if (refreshKey !== "off") {
              setRefreshKey(recommendedRefreshKey(to - from));
            }
          }}
          onFilterLevel={toggleLevelFilter}
          onReset={customRange ? clearCustomRange : undefined}
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
        {selected && (
          <EventDrawer
            event={selected}
            onClose={() => setSelected(null)}
            onFilter={(term) => applyQuery(addTerm(q, term))}
          />
        )}
      </div>
    </div>
  );
}
