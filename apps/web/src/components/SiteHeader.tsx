import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ChevronDownIcon, LogOutIcon, SettingsIcon } from "lucide-react";
import { hasPermission, useApp } from "../app-context";
import Logo from "./Logo";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export default function SiteHeader({ children }: { children?: ReactNode }) {
  const { user, projects, currentProjectId, setProjectId, signOut, permissions } = useApp();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const onProjectSettings = pathname.startsWith("/projects/");
  const currentProject = projects.find((project) => project.id === currentProjectId);

  const canManageProject =
    hasPermission(permissions, "projects.write") ||
    hasPermission(permissions, "keys.read") ||
    currentProject?.canClearLogs === true;

  const switchProject = (id: string): void => {
    setProjectId(id);

    // On a project's settings, switching follows to the other project's settings.
    if (onProjectSettings) void navigate({ to: "/projects/$projectId", params: { projectId: id } });
  };

  const initials = (user.name.trim() || user.email).slice(0, 2).toUpperCase();

  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-white/[0.08] bg-ink-950/90 px-4 py-2.5">
      <Link
        to="/"
        search={(prev) => ({ q: prev.q, from: prev.from, to: prev.to })}
        className="group flex items-center gap-2.5"
        aria-label="Kinglet home"
      >
        <Logo className="size-5 text-gold transition-colors group-hover:text-gold-bright" />
        <span className="font-display text-[15px] font-bold tracking-[0.1em] text-mist">
          KINGLET
        </span>
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
        <div className="flex items-stretch">
          <Select value={String(currentProjectId)} onValueChange={switchProject}>
            <SelectTrigger
              size="sm"
              // On project settings the picker lights up with the cog as one control.
              data-active={onProjectSettings}
              className={`min-w-28 data-[active=true]:border-gold/30 data-[active=true]:bg-gold/[0.08] data-[active=true]:text-gold data-[active=true]:[&_svg]:text-gold/70 ${canManageProject ? "rounded-r-none" : ""}`}
              aria-label="Current project"
            >
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
          {canManageProject && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Link
                  to="/projects/$projectId"
                  params={{ projectId: currentProjectId }}
                  activeOptions={{ includeSearch: false }}
                  aria-label={`Settings for ${currentProject?.name ?? "this project"}`}
                  className="flex w-7 items-center justify-center rounded-r-[5px] border border-l-0 border-white/[0.08] bg-ink-900 text-mist-faint transition-colors hover:bg-gold/[0.05] hover:text-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/30 aria-[current=page]:border-gold/30 aria-[current=page]:bg-gold/[0.08] aria-[current=page]:text-gold"
                  // Styled from aria-current so the lit state outranks the base colors.
                  activeProps={{ "aria-current": "page" }}
                >
                  <SettingsIcon className="size-3.5" />
                </Link>
              </TooltipTrigger>
              <TooltipContent>Project settings</TooltipContent>
            </Tooltip>
          )}
        </div>
      ) : (
        <span className="font-mono text-[10px] text-mist-faint">no project</span>
      )}

      <div className="ml-auto flex flex-wrap items-center gap-3">
        {children}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="gap-2.5 rounded-[5px] border-white/[0.08] bg-ink-900 py-0 pr-2.5 pl-2 hover:bg-ink-900"
              aria-label="Account menu"
            >
              <Avatar size="sm" className="size-5 data-[size=sm]:size-5 after:hidden">
                <AvatarFallback className="bg-gold/[0.08] font-mono text-[9px] font-semibold text-gold group-data-[size=sm]/avatar:text-[9px]">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <span className="hidden max-w-36 truncate font-mono text-[10px] text-mist-dim md:inline">
                {user.email}
              </span>
              <ChevronDownIcon className="size-3 text-mist-faint" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64 p-1.5">
            <DropdownMenuLabel className="p-0 font-normal normal-case tracking-normal">
              <div className="flex items-center gap-2.5 px-2 py-2.5">
                <Avatar size="sm" className="size-7 data-[size=sm]:size-7 after:hidden">
                  <AvatarFallback className="bg-gold/[0.08] font-mono text-[10px] font-semibold text-gold group-data-[size=sm]/avatar:text-[10px]">
                    {initials}
                  </AvatarFallback>
                </Avatar>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate font-mono text-xs font-medium text-mist">
                    {user.name || user.email}
                  </span>
                  <span className="truncate font-mono text-[10px] text-mist-faint">
                    {user.email}
                  </span>
                </div>
                <span className="shrink-0 rounded-[3px] bg-white/[0.04] px-1.5 py-0.5 font-mono text-[9px] text-mist-dim">
                  {user.role}
                </span>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator className="my-1.5" />
            <DropdownMenuGroup>
              <DropdownMenuItem
                className="px-2 py-2"
                onSelect={() => void navigate({ to: "/settings", search: { tab: "account" } })}
              >
                <SettingsIcon />
                Account settings
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator className="my-1.5" />
            <DropdownMenuItem className="px-2 py-2" variant="destructive" onSelect={signOut}>
              <LogOutIcon />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
