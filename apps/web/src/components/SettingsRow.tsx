import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * One line of a settings card: what it is on the left, its value or control
 * on the right. Rows stack on narrow screens and divide each other.
 */
export default function SettingsRow({
  label,
  description,
  htmlFor,
  children,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  /** Ties the label to a control in the row. */
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 border-b border-white/[0.06] py-3 first:pt-0 last:border-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6",
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="font-mono text-xs text-mist">
            {label}
          </label>
        ) : (
          <span className="font-mono text-xs text-mist">{label}</span>
        )}
        {description && (
          <span className="max-w-md font-mono text-[10px] leading-relaxed text-mist-faint">
            {description}
          </span>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">{children}</div>
    </div>
  );
}
