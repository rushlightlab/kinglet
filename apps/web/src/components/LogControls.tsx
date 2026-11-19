import { useEffect, useState } from "react";
import {
  ActivityIcon,
  ArrowDownToLineIcon,
  CheckIcon,
  ChevronDownIcon,
  Clock3Icon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import type { Service } from "../types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  MAX_RANGE_MS,
  REFRESH_OPTIONS,
  refreshLabel,
  toDatetimeLocal,
  WINDOW_PRESETS,
  windowLabel,
} from "../time";
import type { RefreshKey } from "../time";

interface LogControlsProps {
  rangeKey: string;
  windowMs: number;
  refreshKey: RefreshKey;
  customRange: { from: number; to: number } | null;
  onRangeChange: (value: string) => void;
  onCustomRange: (range: { from: number; to: number }) => void;
  onClearCustom: () => void;
  onRefreshChange: (key: RefreshKey) => void;
  live: boolean;
  follow: boolean;
  onToggleLive: () => void;
  onToggleFollow: () => void;
  services: Service[];
  appliedQ: string;
  onApplyQuery: (q: string) => void;
}

function serviceTerm(name: string): string {
  const lower = name.toLowerCase();
  return /\s/.test(lower) ? `service:"${lower}"` : `service:${lower}`;
}

function toggleTerm(q: string, term: string): string {
  const parts = q.split(/\s+/).filter(Boolean);
  const idx = parts.indexOf(term);
  if (idx >= 0) parts.splice(idx, 1);
  else parts.push(term);
  return parts.join(" ");
}

function formatShortTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function customRangeTitle(range: { from: number; to: number }): string {
  return `${formatShortTime(range.from)} to ${formatShortTime(range.to)}`;
}

const segmentClass =
  "flex items-center gap-1.5 px-2.5 font-mono text-[10px] transition-colors " +
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-gold/40";

const presetButtonClass =
  "h-7 rounded-[4px] border font-mono text-[10px] transition-colors " +
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gold/40";

export default function LogControls(props: LogControlsProps) {
  const [open, setOpen] = useState(false);
  const [fromDraft, setFromDraft] = useState("");
  const [toDraft, setToDraft] = useState("");
  const [rangeError, setRangeError] = useState<string | null>(null);

  const terms = props.appliedQ
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => term.toLowerCase());

  useEffect(() => {
    if (!open) return;
    const now = Date.now();
    const initial = props.customRange ?? { from: now - props.windowMs, to: now };
    setFromDraft(toDatetimeLocal(initial.from));
    setToDraft(toDatetimeLocal(initial.to));
    setRangeError(null);
  }, [open, props.customRange, props.windowMs]);

  const pickPreset = (key: string): void => {
    props.onRangeChange(key);
    setOpen(false);
  };

  const applyCustom = (): void => {
    const from = Date.parse(fromDraft);
    const to = Date.parse(toDraft);
    if (!fromDraft || !toDraft || !Number.isFinite(from) || !Number.isFinite(to)) {
      setRangeError("Enter both a start and end time.");
      return;
    }
    if (from >= to) {
      setRangeError("Start must be before end.");
      return;
    }
    if (to - from > MAX_RANGE_MS) {
      setRangeError("Keep the range within 31 days.");
      return;
    }
    props.onCustomRange({ from, to });
    setOpen(false);
  };

  const clearCustom = (): void => {
    props.onClearCustom();
    setOpen(false);
  };

  return (
    <div
      role="group"
      aria-label="Log view controls"
      className="flex h-7 items-stretch overflow-hidden rounded-[5px] border border-white/[0.09] bg-ink-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]"
    >
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={`${segmentClass} ${
                  props.customRange
                    ? "text-gold hover:bg-gold/[0.06]"
                    : "text-mist-dim hover:bg-white/[0.025] hover:text-mist"
                } data-[state=open]:bg-white/[0.03] data-[state=open]:text-mist`}
              >
                <Clock3Icon
                  className={`size-3 ${props.customRange ? "text-gold/70" : "text-mist-faint"}`}
                />
                <span className="whitespace-nowrap">
                  {props.customRange ? "custom" : windowLabel(props.rangeKey)}
                </span>
                {props.refreshKey !== "off" && (
                  <span className="flex items-center gap-0.5 text-[9px] text-gold/60">
                    <RefreshCwIcon className="size-2.5" />
                    {refreshLabel(props.refreshKey)}
                  </span>
                )}
                <ChevronDownIcon className="size-3 text-mist-faint" />
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>
            {props.customRange
              ? `Custom range: ${customRangeTitle(props.customRange)}`
              : `Time window: ${windowLabel(props.rangeKey)}`}
          </TooltipContent>
        </Tooltip>
        <PopoverContent align="start" className="w-[19rem] p-0">
          <div className="p-3">
            <p className="text-[11px] font-medium text-mist">Quick range</p>
            <div className="mt-2 grid grid-cols-3 gap-1.5">
              {WINDOW_PRESETS.map((preset) => {
                const active = !props.customRange && props.rangeKey === preset.key;
                return (
                  <button
                    key={preset.key}
                    type="button"
                    aria-pressed={active}
                    onClick={() => pickPreset(preset.key)}
                    className={`${presetButtonClass} ${
                      active
                        ? "border-gold/35 bg-gold/[0.08] text-gold"
                        : "border-white/[0.08] bg-ink-900 text-mist-dim hover:border-gold/25 hover:text-mist"
                    }`}
                  >
                    {preset.gridLabel}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="border-t border-white/[0.07] p-3">
            <div className="flex flex-col gap-2">
              <label htmlFor="range-start" className="flex flex-col gap-1">
                <span className="text-[10px] text-mist-dim">start</span>
                <Input
                  id="range-start"
                  type="datetime-local"
                  value={fromDraft}
                  onChange={(e) => setFromDraft(e.target.value)}
                  className="h-7 px-2 text-[10px] [color-scheme:dark]"
                />
              </label>
              <label htmlFor="range-end" className="flex flex-col gap-1">
                <span className="text-[10px] text-mist-dim">end</span>
                <Input
                  id="range-end"
                  type="datetime-local"
                  value={toDraft}
                  onChange={(e) => setToDraft(e.target.value)}
                  className="h-7 px-2 text-[10px] [color-scheme:dark]"
                />
              </label>
            </div>

            {rangeError && <p className="mt-2 text-[10px] text-coral">{rangeError}</p>}

            <div className="mt-3 border-t border-white/[0.07] pt-3">
              <p className="text-[11px] font-medium text-mist">Refresh rate</p>
              <div className="mt-2 grid grid-cols-2 gap-1.5">
                {REFRESH_OPTIONS.map((option) => {
                  const active = props.refreshKey === option.key;
                  return (
                    <button
                      key={option.key}
                      type="button"
                      aria-pressed={active}
                      onClick={() => props.onRefreshChange(option.key)}
                      className={`${presetButtonClass} ${
                        active
                          ? "border-gold/35 bg-gold/[0.08] text-gold"
                          : "border-white/[0.08] bg-ink-900 text-mist-dim hover:border-gold/25 hover:text-mist"
                      }`}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 text-[9px] leading-relaxed text-mist-faint">
                off leaves the live tail as the only source. a rate re-fetches the window on that
                interval.
              </p>
            </div>

            <div className="mt-3 flex items-center justify-between gap-2">
              {props.customRange ? (
                <Button variant="ghost" size="xs" onClick={clearCustom}>
                  <XIcon data-icon="inline-start" />
                  clear
                </Button>
              ) : (
                <span aria-hidden="true" />
              )}
              <div className="flex gap-1.5">
                <Button variant="ghost" size="xs" onClick={() => setOpen(false)}>
                  cancel
                </Button>
                <Button variant="soft" size="xs" onClick={applyCustom}>
                  apply
                </Button>
              </div>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      <span aria-hidden="true" className="my-1 w-px bg-white/[0.07]" />

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            role="switch"
            aria-checked={props.live}
            onClick={props.onToggleLive}
            className={`${segmentClass} ${
              props.live
                ? "bg-gold/[0.07] text-gold"
                : "text-mist-dim hover:bg-white/[0.025] hover:text-mist"
            }`}
          >
            {props.live ? (
              <span className="k-live-dot" aria-hidden="true" />
            ) : (
              <span
                aria-hidden="true"
                className="size-[5px] rounded-full border border-mist-faint"
              />
            )}
            live
          </button>
        </TooltipTrigger>
        <TooltipContent>
          {props.live
            ? "Pause the live tail (l). New events stop arriving."
            : "Resume the live tail (l). New events appear as they arrive."}
        </TooltipContent>
      </Tooltip>

      <span aria-hidden="true" className="my-1 w-px bg-white/[0.07]" />

      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="flex rounded-[4px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gold/40"
            tabIndex={props.live ? -1 : 0}
          >
            <button
              type="button"
              role="switch"
              aria-checked={props.follow}
              onClick={props.onToggleFollow}
              disabled={!props.live}
              className={`${segmentClass} ${
                props.follow && props.live
                  ? "text-gold hover:bg-gold/[0.04]"
                  : "text-mist-dim hover:bg-white/[0.025] hover:text-mist"
              } disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-mist-dim`}
            >
              <ArrowDownToLineIcon className="size-3" />
              follow
            </button>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {props.live
            ? props.follow
              ? "Stop staying pinned to the newest event (f)"
              : "Stay pinned to the newest event (f)"
            : "Live tail must be running to follow"}
        </TooltipContent>
      </Tooltip>

      <span aria-hidden="true" className="my-1 w-px bg-white/[0.07]" />
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="flex rounded-[4px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gold/40"
              tabIndex={props.services.length === 0 ? 0 : -1}
            >
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  disabled={props.services.length === 0}
                  className={`${segmentClass} text-mist-faint hover:bg-white/[0.025] hover:text-mist data-[state=open]:bg-white/[0.03] data-[state=open]:text-mist disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-mist-faint`}
                >
                  <ActivityIcon className="size-3" />
                  <span className={props.services.length > 0 ? "text-mist" : undefined}>
                    {props.services.length}
                  </span>
                  services
                </button>
              </DropdownMenuTrigger>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {props.services.length > 0
              ? "Filter by a service seen in this project"
              : "No services have reported events yet"}
          </TooltipContent>
        </Tooltip>
        {props.services.length > 0 && (
          <DropdownMenuContent align="end" className="min-w-52">
            <DropdownMenuLabel>Filter by service</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {props.services.map((service) => {
              const term = serviceTerm(service.name);
              const active = terms.includes(term);
              return (
                <DropdownMenuItem
                  key={service.name}
                  onSelect={() => props.onApplyQuery(toggleTerm(props.appliedQ, term))}
                  className={active ? "text-gold" : undefined}
                >
                  {active ? (
                    <CheckIcon className="text-gold" />
                  ) : (
                    <span aria-hidden="true" className="size-3.5" />
                  )}
                  <span className="truncate">{service.name}</span>
                  <DropdownMenuShortcut>{service.count.toLocaleString()}</DropdownMenuShortcut>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        )}
      </DropdownMenu>
    </div>
  );
}
