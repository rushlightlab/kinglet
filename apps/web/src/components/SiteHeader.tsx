import { Link, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ChevronDownIcon, LogOutIcon, SettingsIcon } from "lucide-react";
import { useApp } from "../app-context";
import Crown from "./Crown";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export default function SiteHeader({ children }: { children?: ReactNode }) {
  const { user, projects, currentProjectId, setProjectId, signOut } = useApp();
  const navigate = useNavigate();
  const initials = (user.name.trim() || user.email).slice(0, 2).toUpperCase();

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
              <SelectLabel>Project</SelectLabel>
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

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="gap-2 px-2" aria-label="Account menu">
              <Avatar size="sm" className="border border-white/[0.1]">
                <AvatarFallback className="bg-ink-800 font-mono text-[10px] text-gold">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <span className="hidden max-w-36 truncate font-mono text-[10px] text-mist-dim md:inline">
                {user.email}
              </span>
              <Badge
                variant="outline"
                className="hidden text-[9px] normal-case tracking-normal sm:inline-flex"
              >
                {user.role}
              </Badge>
              <ChevronDownIcon className="size-3 text-mist-faint" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-56">
            <DropdownMenuLabel className="normal-case tracking-normal">
              <div className="flex flex-col gap-1">
                <span className="font-mono text-xs text-mist">{user.name || user.email}</span>
                <span className="font-mono text-[10px] text-mist-faint">{user.email}</span>
                <Badge
                  variant="outline"
                  className="w-fit text-[9px] normal-case tracking-normal"
                >
                  {user.role}
                </Badge>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onSelect={() => void navigate({ to: "/settings" })}>
                <SettingsIcon />
                Settings
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={signOut}>
              <LogOutIcon />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
