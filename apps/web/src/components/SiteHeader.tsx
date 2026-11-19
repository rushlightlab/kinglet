import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useApp } from "../app-context";
import Crown from "./Crown";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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
        <Crown className="size-5 text-gold transition-colors group-hover:text-gold-bright" />
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

      {projects.length > 0 ? (
        <Select
          value={String(currentProjectId)}
          onValueChange={(value) => setProjectId(Number(value))}
        >
          <SelectTrigger size="sm" className="min-w-28" aria-label="Current project">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {projects.map((project) => (
                <SelectItem key={project.id} value={String(project.id)}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      ) : (
        <span className="font-mono text-[10px] text-mist-faint">no project</span>
      )}

      <div className="ml-auto flex flex-wrap items-center gap-2">
        {children}
        <span className="hidden font-mono text-[10px] text-mist-faint md:inline">
          {user.email} · {user.role}
        </span>
        <Button variant="chip" size="xs" onClick={signOut}>
          sign out
        </Button>
      </div>
    </header>
  );
}
