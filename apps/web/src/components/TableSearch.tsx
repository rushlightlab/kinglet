import { SearchIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { TableCell, TableRow } from "@/components/ui/table";

/**
 * The search box above a table. Escape clears it; the clear button appears
 * once there is something to clear.
 */
export default function TableSearch({
  value,
  onChange,
  label,
  placeholder,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Accessible name, e.g. "Search monitors". */
  label: string;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={cn("relative w-full sm:w-60", className)}>
      <SearchIcon
        className="pointer-events-none absolute top-1/2 left-2.5 size-3 -translate-y-1/2 text-mist-faint"
        aria-hidden="true"
      />
      <input
        type="search"
        value={value}
        aria-label={label}
        placeholder={placeholder ?? `${label.toLowerCase()}…`}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value !== "") {
            event.preventDefault();
            onChange("");
          }
        }}
        className="h-7 w-full rounded-[4px] border border-white/[0.08] bg-ink-900 pr-7 pl-7 font-mono text-[11px] text-mist outline-none transition-colors placeholder:text-mist-faint focus-visible:border-gold/40 focus-visible:ring-2 focus-visible:ring-gold/15 [&::-webkit-search-cancel-button]:hidden"
      />
      {value !== "" && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange("")}
          className="absolute top-1/2 right-1.5 flex size-4 -translate-y-1/2 items-center justify-center rounded-[3px] text-mist-faint transition-colors hover:bg-white/[0.06] hover:text-mist focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gold/40"
        >
          <XIcon className="size-3" />
        </button>
      )}
    </div>
  );
}

/** The row a table shows when its search hides every row. */
export function NoMatchesRow({
  columns,
  query,
  noun,
  onClear,
}: {
  columns: number;
  query: string;
  /** Plural, e.g. "monitors". */
  noun: string;
  onClear: () => void;
}) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={columns} className="py-6 text-center text-mist-faint">
        No {noun} match “{query.trim()}”.{" "}
        <button
          type="button"
          onClick={onClear}
          className="text-gold/80 underline-offset-2 hover:text-gold hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gold/40"
        >
          clear search
        </button>
      </TableCell>
    </TableRow>
  );
}
