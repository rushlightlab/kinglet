import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useApp } from "../app-context";
import Crown from "./Crown";

export default function SiteHeader({ children }: { children?: ReactNode }) {
  const { user, projects, currentProjectId, setProjectId, signOut } = useApp();

  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-white/[0.08] bg-ink-950/90 px-4 py-2.5">
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
        <Link to="/settings" className="nav-link" activeProps={{ className: "nav-link-active" }}>
          /settings
        </Link>
      </nav>

      <select
        value={currentProjectId}
        onChange={(e) => setProjectId(Number(e.target.value))}
        className="k-chip-btn cursor-pointer bg-ink-900"
        title="Current project"
        aria-label="Current project"
      >
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>

      <div className="ml-auto flex flex-wrap items-center gap-2">
        {children}
        <span className="hidden font-mono text-[10px] text-mist-faint md:inline">
          {user.email} · {user.role}
        </span>
        <button onClick={signOut} className="k-chip-btn">
          sign out
        </button>
      </div>
    </header>
  );
}
