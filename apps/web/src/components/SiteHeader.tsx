import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import Crown from "./Crown";

export default function SiteHeader({ children }: { children?: ReactNode }) {
  return (
    <header className="flex items-center gap-4 border-b border-white/[0.08] bg-ink-950/90 px-4 py-2.5">
      <Link
        to="/"
        search={(prev) => ({ q: prev.q, from: prev.from, to: prev.to })}
        className="group flex items-center gap-2.5"
        aria-label="Kinglet home"
      >
        <Crown className="h-5 w-5 text-gold transition-colors group-hover:text-gold-bright" />
        <span className="font-display text-[15px] font-bold tracking-[0.1em] text-mist">KINGLET</span>
      </Link>
      <nav className="flex items-center gap-1" aria-label="Main navigation">
        <Link
          to="/"
          search={(prev) => ({ q: prev.q, from: prev.from, to: prev.to })}
          activeOptions={{ exact: true }}
          className="nav-link"
          activeProps={{ className: "nav-link-active" }}
        >
          /logs
        </Link>
        <Link to="/monitors" className="nav-link" activeProps={{ className: "nav-link-active" }}>
          /monitors
        </Link>
      </nav>
      <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>
    </header>
  );
}
