import { cn } from "@/lib/utils";

/** A placeholder block shown while content loads; decorative, so hidden from screen readers. */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn(
        "animate-pulse rounded-[3px] bg-white/[0.08] motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
