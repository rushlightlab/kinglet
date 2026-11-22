import { useState } from "react";
import type { RefObject } from "react";
import { LinkIcon, RefreshCwIcon, StarIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isJsonObject, isString } from "../json";
import { TEXT_SCOPES, textScopeOf, withTextScope } from "../query";
import type { Vocabulary } from "../query";
import QueryInput from "./QueryInput";
import { LEVEL_COLORS, LEVEL_NAMES } from "../types";

const SAVED_KEY = "kinglet.saved";

interface SavedSearch {
  name: string;
  q: string;
}

function isSavedSearch(value: unknown): value is SavedSearch {
  return isJsonObject(value) && isString(value.name) && isString(value.q);
}

function loadSaved(): SavedSearch[] {
  try {
    const raw = localStorage.getItem(SAVED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];

    return Array.isArray(parsed) ? parsed.filter(isSavedSearch) : [];
  } catch {
    return [];
  }
}

function toggleTerm(q: string, term: string): string {
  const parts = q.split(/\s+/).filter(Boolean);
  const idx = parts.indexOf(term);

  if (idx >= 0) parts.splice(idx, 1);
  else parts.push(term);

  return parts.join(" ");
}

interface FilterBarProps {
  value: string;
  onChange: (value: string) => void;
  onEnter: () => void;
  onRefresh: () => void;
  onCopyLink: () => void;
  appliedQ: string;
  onApplyQuery: (q: string) => void;
  count: number;
  busy: boolean;
  error: string | null;
  inputRef: RefObject<HTMLInputElement | null>;
  /** Field keys, services, and envs from recent events, for autocomplete. */
  vocabulary: Vocabulary;
}

export default function FilterBar(props: FilterBarProps) {
  const [saved, setSaved] = useState<SavedSearch[]>(loadSaved);
  const [copied, setCopied] = useState(false);

  const saveCurrent = (): void => {
    const q = props.appliedQ.trim();

    if (!q) return;
    const name = q.length > 28 ? `${q.slice(0, 25)}…` : q;
    setSaved((prev) => {
      const next = [{ name, q }, ...prev.filter((s) => s.q !== q)].slice(0, 8);

      try {
        localStorage.setItem(SAVED_KEY, JSON.stringify(next));
      } catch {
        // storage full or unavailable — chips stay for this session
      }

      return next;
    });
  };

  const removeSaved = (q: string): void => {
    setSaved((prev) => {
      const next = prev.filter((s) => s.q !== q);

      try {
        localStorage.setItem(SAVED_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }

      return next;
    });
  };

  const scope = textScopeOf(props.appliedQ);

  const clearSearch = (): void => {
    props.onApplyQuery("");
    props.inputRef.current?.focus();
  };

  const copyLink = (): void => {
    props.onCopyLink();
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="border-b border-white/[0.08] px-4 py-2">
      <div className="flex items-center gap-2.5 rounded-[5px] border border-white/[0.08] bg-ink-900/90 px-3 py-1.5 transition-colors focus-within:border-gold/30">
        <span aria-hidden="true" className="text-gold">
          ⌕
        </span>
        <QueryInput
          inputRef={props.inputRef}
          value={props.value}
          onChange={props.onChange}
          onEnter={props.onEnter}
          onClear={clearSearch}
          vocabulary={props.vocabulary}
          placeholder="level:error service:api field.status>=500"
          className="w-full bg-transparent font-mono text-xs text-mist outline-none placeholder:text-mist-faint"
        />
        {props.value !== "" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="chip" size="icon-xs" onClick={clearSearch} aria-label="Clear search">
                <XIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Clear search (Esc)</TooltipContent>
          </Tooltip>
        )}
        {props.appliedQ.trim() && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="chip" size="xs" onClick={saveCurrent}>
                <StarIcon data-icon="inline-start" />
                save
              </Button>
            </TooltipTrigger>
            <TooltipContent>Save this search</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="chip" size="xs" onClick={copyLink}>
              <LinkIcon data-icon="inline-start" />
              {copied ? "linked" : "link"}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Copy a link to this view</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="chip" size="icon-xs" onClick={props.onRefresh} aria-label="Refresh">
              <RefreshCwIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh the current window</TooltipContent>
        </Tooltip>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {LEVEL_NAMES.map((name, i) => {
          const color = LEVEL_COLORS[i] ?? "#6b756c";
          const term = `level:${name}`;
          const active = props.appliedQ.split(/\s+/).includes(term);

          return (
            <Tooltip key={name}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => props.onApplyQuery(toggleTerm(props.appliedQ, term))}
                  className="rounded-[3px] border px-1.5 py-0.5 font-mono text-[10px] transition-colors"
                  style={{
                    color: active ? "#07080a" : color,
                    borderColor: `${color}44`,
                    background: active ? color : `${color}0d`,
                  }}
                >
                  {name}
                </button>
              </TooltipTrigger>
              <TooltipContent>Toggle {term}</TooltipContent>
            </Tooltip>
          );
        })}
        <span className="mx-1 h-4 w-px bg-white/[0.08]" aria-hidden="true" />
        <span className="font-mono text-[10px] text-mist-faint">text in</span>
        <div
          role="radiogroup"
          aria-label="Free text searches"
          className="flex overflow-hidden rounded-[3px] border border-white/[0.08]"
        >
          {TEXT_SCOPES.map(({ scope: option, label, hint }) => {
            const active = scope === option;

            return (
              <Tooltip key={option}>
                <TooltipTrigger asChild>
                  <button
                    role="radio"
                    aria-checked={active}
                    onClick={() => props.onApplyQuery(withTextScope(props.appliedQ, option))}
                    className={
                      "px-1.5 py-0.5 font-mono text-[10px] transition-colors " +
                      (active ? "bg-gold/15 text-gold" : "text-mist-faint hover:text-mist")
                    }
                  >
                    {label}
                  </button>
                </TooltipTrigger>
                <TooltipContent>{hint}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>
        {saved.length > 0 && <span className="mx-1 h-4 w-px bg-white/[0.08]" aria-hidden="true" />}
        {saved.map((s) => (
          <span
            key={s.q}
            className="flex items-stretch overflow-hidden rounded-[3px] border border-gold/25 bg-gold/[0.06] font-mono text-[10px] text-gold"
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => props.onApplyQuery(s.q)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    removeSaved(s.q);
                  }}
                  className="px-1.5 py-0.5 transition-colors hover:bg-gold/10"
                >
                  {s.name}
                </button>
              </TooltipTrigger>
              <TooltipContent>Apply {s.q}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => removeSaved(s.q)}
                  aria-label={`Remove saved search ${s.name}`}
                  className="border-l border-gold/20 px-1 text-gold/60 transition-colors hover:bg-coral/15 hover:text-coral"
                >
                  <XIcon aria-hidden="true" className="size-2.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Remove saved search</TooltipContent>
            </Tooltip>
          </span>
        ))}
        <span className="ml-auto font-mono text-[10px] text-mist-faint">
          {props.error ? (
            <span className="text-coral">{props.error}</span>
          ) : props.busy ? (
            <span className="text-gold/80">searching…</span>
          ) : (
            `${props.count.toLocaleString()} ${props.count === 1 ? "event" : "events"}`
          )}
        </span>
      </div>
    </div>
  );
}
