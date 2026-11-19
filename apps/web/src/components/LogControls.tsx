import {
  ActivityIcon,
  ArrowDownToLineIcon,
  CheckIcon,
  Clock3Icon,
  XIcon,
} from "lucide-react";
import type { Service } from "../types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const WINDOWS = ["15m", "1h", "6h", "24h", "7d"] as const;

interface LogControlsProps {
  rangeKey: string;
  customRange: { from: number; to: number } | null;
  onRangeChange: (value: string) => void;
  onClearCustom: () => void;
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

function customRangeTitle(range: { from: number; to: number }): string {
  const fmt = (ts: number): string =>
    new Date(ts).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  return `${fmt(range.from)} to ${fmt(range.to)}`;
}

const segmentClass =
  "flex items-center gap-1.5 px-2.5 font-mono text-[10px] transition-colors " +
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-gold/40";

export default function LogControls(props: LogControlsProps) {
  const terms = props.appliedQ
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => term.toLowerCase());

  return (
    <div
      role="group"
      aria-label="Log view controls"
      className="flex h-7 items-stretch overflow-hidden rounded-[5px] border border-white/[0.09] bg-ink-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]"
    >
      {props.customRange ? (
        <button
          type="button"
          onClick={props.onClearCustom}
          className={`${segmentClass} text-gold hover:bg-gold/[0.06]`}
          title={`Custom range: ${customRangeTitle(props.customRange)}. Click to clear.`}
        >
          <Clock3Icon className="size-3 text-gold/70" />
          custom
          <XIcon className="size-3 text-gold/60" />
        </button>
      ) : (
        <Select value={props.rangeKey} onValueChange={props.onRangeChange}>
          <SelectTrigger
            size="sm"
            aria-label="Time window"
            className="h-7 w-auto gap-1.5 rounded-none border-0 bg-transparent px-2.5 text-[10px] text-mist-dim shadow-none hover:bg-white/[0.025] hover:text-mist focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-gold/40 data-[size=sm]:pl-2.5 [&>span]:line-clamp-none [&>svg]:size-3"
          >
            <Clock3Icon className="size-3 text-mist-faint" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>Time window</SelectLabel>
              {WINDOWS.map((key) => (
                <SelectItem key={key} value={key}>
                  last {key}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      )}

      <span aria-hidden="true" className="my-1 w-px bg-white/[0.07]" />

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
        title={props.live ? "Pause the live tail (l)" : "Resume the live tail (l)"}
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

      <span aria-hidden="true" className="my-1 w-px bg-white/[0.07]" />

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
        title={
          props.live
            ? props.follow
              ? "Stop staying pinned to the newest event (f)"
              : "Stay pinned to the newest event (f)"
            : "Live tail must be running to follow"
        }
      >
        <ArrowDownToLineIcon className="size-3" />
        follow
      </button>

      <span aria-hidden="true" className="my-1 w-px bg-white/[0.07]" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={props.services.length === 0}
            className={`${segmentClass} text-mist-faint hover:bg-white/[0.025] hover:text-mist data-[state=open]:bg-white/[0.03] data-[state=open]:text-mist disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-mist-faint`}
            title={
              props.services.length > 0
                ? "Filter by a service seen in this project"
                : "No services have reported events yet"
            }
          >
            <ActivityIcon className="size-3" />
            <span className={props.services.length > 0 ? "text-mist" : undefined}>
              {props.services.length}
            </span>
            services
          </button>
        </DropdownMenuTrigger>
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
                  <DropdownMenuShortcut>
                    {service.count.toLocaleString()}
                  </DropdownMenuShortcut>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        )}
      </DropdownMenu>
    </div>
  );
}
