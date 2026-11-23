import { useEffect, useState } from "react";
import { Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { clearProjectLogs, fetchClearPreview, fetchServices } from "../../api";
import { toDatetimeLocal } from "../../time";
import type { ClearPreview, Service } from "../../types";
import ErrorAlert from "../ErrorAlert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type ClearRange = "1h" | "6h" | "24h" | "7d" | "30d" | "all" | "custom";

const CLEAR_RANGES: readonly ClearRange[] = ["1h", "6h", "24h", "7d", "30d", "all", "custom"];
const CLEAR_RANGE_SET = new Set<string>(CLEAR_RANGES);

function isClearRange(value: string): value is ClearRange {
  return CLEAR_RANGE_SET.has(value);
}

const CLEAR_RANGE_MS: Record<Exclude<ClearRange, "all" | "custom">, number> = {
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
  "30d": 30 * 24 * 60 * 60_000,
};

/** Select value for "no service filter"; service names never contain spaces at the edges. */
const ANY_SERVICE = " any";

const PREVIEW_DEBOUNCE_MS = 400;

/** The absolute window for a range choice, resolved against now; undefined for all time or an invalid custom range. */
function resolveRange(
  range: ClearRange,
  customFrom: string,
  customTo: string,
): { from: number; to: number } | undefined {
  if (range === "all") return undefined;
  const to = range === "custom" ? Date.parse(customTo) : Date.now();
  const from = range === "custom" ? Date.parse(customFrom) : to - CLEAR_RANGE_MS[range];

  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return undefined;

  return { from, to };
}

function serviceTerm(name: string): string {
  const lower = name.toLowerCase();

  return /\s/.test(lower) ? `service:"${lower}"` : `service:${lower}`;
}

/** The Trill query a clear runs: the chosen service plus any typed filter. */
function clearQuery(service: string, query: string): string {
  return [service === ANY_SERVICE ? "" : serviceTerm(service), query.trim()]
    .filter(Boolean)
    .join(" ");
}

export default function ClearLogsCard({
  projectId,
  projectName,
  canClear,
}: {
  projectId: string;
  projectName: string;
  canClear: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<ClearRange>("24h");

  const [customFrom, setCustomFrom] = useState(() =>
    toDatetimeLocal(Date.now() - CLEAR_RANGE_MS["24h"]),
  );

  const [customTo, setCustomTo] = useState(() => toDatetimeLocal(Date.now()));
  const [service, setService] = useState(ANY_SERVICE);
  const [query, setQuery] = useState("");
  const [services, setServices] = useState<Service[]>([]);
  const [preview, setPreview] = useState<ClearPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const bounds = resolveRange(range, customFrom, customTo);
  const boundsValid = range === "all" || bounds !== undefined;
  const q = clearQuery(service, query);

  useEffect(() => {
    if (!open || !canClear) return;
    let cancelled = false;

    const load = async (): Promise<void> => {
      try {
        const result = await fetchServices(projectId);

        if (!cancelled) setServices(result.services);
      } catch {
        // The service picker is optional; the query field still works.
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [open, canClear, projectId]);

  // Preview what this selection deletes, debounced while the user types. The
  // relative ranges resolve against "now" when the preview runs.
  useEffect(() => {
    const selected = resolveRange(range, customFrom, customTo);

    if (!open || !canClear || (range !== "all" && selected === undefined)) {
      setPreview(null);

      return;
    }

    let cancelled = false;
    setPreviewing(true);

    const load = async (): Promise<void> => {
      try {
        const result = await fetchClearPreview(projectId, { range: selected, q });

        if (cancelled) return;
        setPreview(result);
        setPreviewError(null);
      } catch (err) {
        if (cancelled) return;
        setPreview(null);
        setPreviewError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setPreviewing(false);
      }
    };

    const timer = setTimeout(() => void load(), PREVIEW_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, canClear, projectId, range, customFrom, customTo, q]);

  if (!canClear) return null;

  const timeSummary =
    range === "all"
      ? "all time"
      : bounds
        ? `${new Date(bounds.from).toLocaleString()} to ${new Date(bounds.to).toLocaleString()}`
        : "pick a valid start and end";

  const clear = async (): Promise<void> => {
    if (confirm !== projectName) return;

    if (!boundsValid) {
      setError("Choose a valid start and end.");

      return;
    }

    setBusy(true);
    setError(null);

    try {
      const result = await clearProjectLogs(projectId, { range: bounds, q });
      toast.success(`Deleted ${result.deleted.toLocaleString()} events`);
      setOpen(false);
      setConfirm("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const nothingToDelete = preview !== null && preview.total === 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Clear logs</CardTitle>
        <CardDescription>
          Delete stored events from this project, by time, service, or query. Keys, monitors, and
          alert history stay.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <AlertDialog
          open={open}
          onOpenChange={(next) => {
            setOpen(next);

            if (!next) {
              setConfirm("");
              setError(null);
              setPreview(null);
            }
          }}
        >
          <AlertDialogTrigger asChild>
            <Button variant="destructive" size="sm">
              <Trash2Icon data-icon="inline-start" />
              clear project logs
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent className="sm:max-w-lg">
            <AlertDialogHeader>
              <AlertDialogTitle>Clear logs in {projectName}?</AlertDialogTitle>
              <AlertDialogDescription>
                Pick what to delete and check the preview. It cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="clear-range">time</FieldLabel>
                <Select
                  value={range}
                  onValueChange={(value) => {
                    if (isClearRange(value)) setRange(value);
                  }}
                >
                  <SelectTrigger id="clear-range" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectLabel>Range</SelectLabel>
                      <SelectItem value="1h">last hour</SelectItem>
                      <SelectItem value="6h">last 6 hours</SelectItem>
                      <SelectItem value="24h">last 24 hours</SelectItem>
                      <SelectItem value="7d">last 7 days</SelectItem>
                      <SelectItem value="30d">last 30 days</SelectItem>
                      <SelectItem value="all">all time</SelectItem>
                      <SelectItem value="custom">custom range</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="clear-service">service</FieldLabel>
                <Select value={service} onValueChange={setService}>
                  <SelectTrigger id="clear-service" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectLabel>Service</SelectLabel>
                      <SelectItem value={ANY_SERVICE}>any service</SelectItem>
                      {services.map((s) => (
                        <SelectItem key={s.name} value={s.name}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </div>

            {range === "custom" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="clear-from">from</FieldLabel>
                  <Input
                    id="clear-from"
                    type="datetime-local"
                    value={customFrom}
                    onChange={(e) => setCustomFrom(e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="clear-to">to</FieldLabel>
                  <Input
                    id="clear-to"
                    type="datetime-local"
                    value={customTo}
                    onChange={(e) => setCustomTo(e.target.value)}
                  />
                </Field>
              </div>
            )}

            <Field>
              <FieldLabel htmlFor="clear-query">only events matching (optional)</FieldLabel>
              <Input
                id="clear-query"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="level<=debug env:staging field.imei:…"
                spellCheck={false}
                autoComplete="off"
                className="font-mono text-xs"
              />
              <FieldDescription>A Trill query, the same syntax as the log search.</FieldDescription>
            </Field>

            <ClearPreviewPanel
              preview={preview}
              previewing={previewing}
              error={previewError}
              timeSummary={timeSummary}
            />

            <Field>
              <FieldLabel htmlFor="clear-confirm">type {projectName} to confirm</FieldLabel>
              <Input
                id="clear-confirm"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder={projectName}
                autoComplete="off"
              />
            </Field>

            <ErrorAlert error={error} />

            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={busy || confirm !== projectName || !boundsValid || nothingToDelete}
                onClick={() => void clear()}
              >
                {busy && <Spinner data-icon="inline-start" />}
                {busy
                  ? "clearing…"
                  : preview
                    ? `Delete ${preview.total.toLocaleString()} events`
                    : "Clear logs"}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

function ClearPreviewPanel({
  preview,
  previewing,
  error,
  timeSummary,
}: {
  preview: ClearPreview | null;
  previewing: boolean;
  error: string | null;
  timeSummary: string;
}) {
  return (
    <section
      aria-label="Clear preview"
      aria-live="polite"
      className="rounded-[5px] border border-white/[0.08] bg-ink-850 p-3 font-mono text-xs"
    >
      {error ? (
        <p className="text-coral">{error}</p>
      ) : !preview ? (
        <p className="text-mist-faint">{previewing ? "counting…" : "no preview yet"}</p>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-mist">
            <span className="text-coral">{preview.total.toLocaleString()}</span> events will be
            deleted · {timeSummary}
            {preview.q ? (
              <>
                {" "}
                · matching <span className="text-gold">{preview.q}</span>
              </>
            ) : null}
            {previewing && <span className="text-mist-faint"> · updating…</span>}
          </p>
          {preview.services.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {preview.services.slice(0, 6).map((s) => (
                <li
                  key={s.key ?? "(none)"}
                  className="rounded-[3px] border border-white/[0.08] px-1.5 py-0.5 text-[10px] text-mist"
                >
                  {s.key ?? "(no service)"} {s.count.toLocaleString()}
                </li>
              ))}
              {(preview.moreServices || preview.services.length > 6) && (
                <li className="px-1 py-0.5 text-[10px] text-mist-faint">and more</li>
              )}
            </ul>
          )}
          {preview.sample.length > 0 && (
            <ul className="flex flex-col gap-0.5 text-[11px] text-mist-faint">
              {preview.sample.slice(0, 3).map((event) => (
                <li key={event.id} className="truncate">
                  {new Date(event.ts).toLocaleString()} · {event.message}
                </li>
              ))}
            </ul>
          )}
          {preview.archive && (
            <p className="text-[11px] text-mist-faint">
              An all-time clear with no filter also deletes this project&apos;s archived logs.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
