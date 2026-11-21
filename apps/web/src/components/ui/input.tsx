import * as React from "react";
import { cn } from "cn";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-[5px] border border-white/[0.08] bg-ink-900 px-3 py-2 font-mono text-xs text-mist transition-colors outline-none placeholder:text-mist-faint focus-visible:border-gold/40 focus-visible:ring-2 focus-visible:ring-gold/15 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-coral/50 aria-invalid:ring-2 aria-invalid:ring-coral/15 file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-xs file:font-medium file:text-mist",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
