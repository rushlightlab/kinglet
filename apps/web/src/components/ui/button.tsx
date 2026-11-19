import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { Slot } from "radix-ui";

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center gap-1.5 rounded-[4px] border border-transparent font-mono text-xs font-semibold whitespace-nowrap transition-all outline-none select-none focus-visible:ring-2 focus-visible:ring-gold/30 disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        default:
          "bg-gold text-ink-950 shadow-[0_0_0_1px_rgba(251,191,36,0.3),0_6px_26px_rgba(251,191,36,0.16)] hover:bg-gold-bright hover:-translate-y-0.5 hover:shadow-[0_0_0_1px_var(--color-gold-bright),0_10px_36px_rgba(251,191,36,0.32)]",
        outline:
          "border-white/[0.1] bg-white/[0.015] text-mist hover:border-gold/40 hover:bg-gold/[0.04] hover:text-gold",
        soft: "border-gold/40 bg-gold/[0.06] text-gold hover:bg-gold/[0.1]",
        secondary:
          "border-white/[0.08] bg-ink-800 text-mist hover:border-gold/30 hover:text-gold",
        ghost: "text-mist-dim hover:bg-gold/[0.05] hover:text-gold",
        destructive:
          "border-coral/30 bg-coral/[0.08] text-coral hover:bg-coral/[0.14] focus-visible:ring-coral/30",
        chip: "border-white/[0.08] bg-transparent text-[10px] font-normal text-mist-dim hover:border-gold/[0.35] hover:bg-gold/[0.05] hover:text-gold",
        link: "text-gold underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-3.5",
        xs: "h-6 px-2",
        sm: "h-7 px-2.5 text-[11px]",
        lg: "h-10 px-4",
        icon: "size-9",
        "icon-xs": "size-6",
        "icon-sm": "size-7",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
