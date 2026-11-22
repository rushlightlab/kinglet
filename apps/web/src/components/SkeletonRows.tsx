import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableRow } from "@/components/ui/table";

/**
 * Placeholder table rows for the first load, so a table never says it is
 * empty before it knows. Screen readers hear a single "Loading…".
 */
export default function SkeletonRows({
  columns,
  rows = 3,
  label = "Loading…",
}: {
  columns: number;
  rows?: number;
  label?: string;
}) {
  return (
    <>
      <TableRow className="sr-only">
        <TableCell colSpan={columns} role="status">
          {label}
        </TableCell>
      </TableRow>
      {Array.from({ length: rows }, (_, row) => (
        <TableRow key={row} aria-hidden="true" className="hover:bg-transparent">
          {Array.from({ length: columns }, (_cell, column) => (
            <TableCell key={column}>
              <Skeleton className={column === 0 ? "h-3.5 w-28" : "h-3.5 w-14"} />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}
