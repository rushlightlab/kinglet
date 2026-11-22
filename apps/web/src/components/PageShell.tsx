import type { ReactNode } from "react";
import SiteHeader from "@/components/SiteHeader";

export default function PageShell({
  kicker,
  title,
  description,
  headerExtra,
  wide = false,
  children,
}: {
  kicker: string;
  title: string;
  description?: string;
  headerExtra?: ReactNode;
  /** Table-heavy pages get more width; forms read better narrow. */
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex h-screen flex-col bg-ink-950 text-mist">
      <SiteHeader>{headerExtra}</SiteHeader>
      <main className="relative flex-1 overflow-y-auto">
        <div className="k-bg-grid absolute inset-0" aria-hidden="true" />
        <div className={`relative mx-auto w-full px-6 py-8 ${wide ? "max-w-5xl" : "max-w-3xl"}`}>
          <div className="k-kicker">
            <span className="text-gold">/</span> {kicker}
          </div>
          <h1 className="font-display mt-2 text-2xl font-bold tracking-wide">{title}</h1>
          {description && (
            <p className="mt-2 max-w-lg font-mono text-xs leading-relaxed text-mist-dim">
              {description}
            </p>
          )}
          {children}
        </div>
      </main>
    </div>
  );
}
