import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { isPageSize, PAGE_SIZES, pageSpan } from "../server-table";
import type { ServerTable } from "../server-table";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";

/**
 * The footer under a server-paged table: rows per page, which rows are shown,
 * and previous/next. Hidden until there is something to page.
 */
export default function TablePagination<T>({
  table,
  noun,
  className,
}: {
  table: ServerTable<T>;
  /** Plural, e.g. "monitors". */
  noun: string;
  className?: string;
}) {
  if (!table.loaded || table.total === 0) return null;
  const { from, to, pages } = pageSpan(table.page, table.pageSize, table.total);
  const pageSizeId = `page-size-${noun.replace(/\W+/g, "-")}`;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] px-4 py-2 font-mono text-[10px] text-mist-faint",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <label htmlFor={pageSizeId}>rows</label>
        <Select
          value={String(table.pageSize)}
          onValueChange={(value) => {
            const size = Number(value);

            if (isPageSize(size)) table.setPageSize(size);
          }}
        >
          <SelectTrigger id={pageSizeId} size="sm" className="h-6 w-16 text-[11px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZES.map((size) => (
              <SelectItem key={size} value={String(size)}>
                {size}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-2">
        {table.loading && <Spinner className="size-3" />}
        <span aria-live="polite">
          {from}–{to} of {table.total.toLocaleString()} {noun}
        </span>
        <Button
          variant="chip"
          size="icon-xs"
          aria-label="Previous page"
          disabled={table.page === 0}
          onClick={() => table.setPage(table.page - 1)}
        >
          <ChevronLeftIcon />
        </Button>
        <Button
          variant="chip"
          size="icon-xs"
          aria-label="Next page"
          disabled={table.page >= pages - 1}
          onClick={() => table.setPage(table.page + 1)}
        >
          <ChevronRightIcon />
        </Button>
      </div>
    </div>
  );
}
