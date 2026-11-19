import * as React from "react";
import { cn } from "cn";
import { Switch as SwitchPrimitive } from "radix-ui";

function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer group/switch relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-white/[0.08] bg-white/[0.03] transition-colors outline-none after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:ring-2 focus-visible:ring-gold/20 disabled:cursor-not-allowed disabled:opacity-50 data-checked:border-gold/40 data-checked:bg-gold/20",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none ml-0.5 block size-3 rounded-full bg-mist-faint transition-transform group-data-[state=checked]/switch:translate-x-[18px] group-data-[state=checked]/switch:bg-gold"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
