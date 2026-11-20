import { useCallback, useEffect, useState } from "react";
import { createRootRoute, Outlet } from "@tanstack/react-router";
import { toast } from "sonner";
import { fetchMe, fetchProjects, logout, UnauthorizedError } from "../api";
import { AppContext } from "../app-context";
import type { AppContextValue } from "../app-context";
import { SystemEventsProvider } from "../system-events";
import ErrorAlert from "../components/ErrorAlert";
import Login from "../components/Login";
import { Button } from "@/components/ui/button";
import type { AppUser, Project } from "../types";

const PROJECT_STORAGE_KEY = "kinglet.project";
const LOCAL_STATE_KEYS = ["kinglet.project", "kinglet.saved", "kinglet.restore.staged"];

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage can be blocked or full; the in-memory state remains usable.
  }
}

function clearLocalState(): void {
  try {
    for (const key of LOCAL_STATE_KEYS) localStorage.removeItem(key);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

export const Route = createRootRoute({
  component: RootComponent,
});

type RootState =
  | { phase: "loading" }
  | { phase: "login"; error?: string }
  | { phase: "offline"; error: string }
  | {
      phase: "ready";
      user: AppUser;
      permissions: string[];
      projects: Project[];
      currentProjectId: string;
    };

function RootComponent() {
  const [state, setState] = useState<RootState>({ phase: "loading" });

  const load = useCallback(async () => {
    try {
      const me = await fetchMe();
      const { projects } = await fetchProjects();
      const storedRaw = readLocal(PROJECT_STORAGE_KEY);
      const urlRaw = new URLSearchParams(window.location.search).get("project");

      const valid = (id: string | null): id is string =>
        id !== null && projects.some((p) => p.id === id);

      const chosen = [urlRaw, storedRaw].find(valid) ?? projects[0]?.id;

      if (chosen === undefined) {
        setState({
          phase: "offline",
          error:
            "No project is available for your account. An administrator can assign you to one in Settings → Projects.",
        });

        return;
      }

      writeLocal(PROJECT_STORAGE_KEY, String(chosen));
      setState({
        phase: "ready",
        user: me.user,
        permissions: me.permissions,
        projects,
        currentProjectId: chosen,
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        clearLocalState();
        setState({ phase: "login" });

        return;
      }

      setState({
        phase: "offline",
        error: err instanceof Error ? err.message : "could not reach the Kinglet API",
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Session expiry detected mid-session by any /v1 call.
  useEffect(() => {
    const onUnauthorized = (): void => {
      clearLocalState();
      toast.dismiss();
      setState({ phase: "login", error: "Your session expired — sign in again." });
    };

    window.addEventListener("kinglet:unauthorized", onUnauthorized);

    return () => window.removeEventListener("kinglet:unauthorized", onUnauthorized);
  }, []);

  if (state.phase === "loading") {
    return (
      <div className="relative flex h-screen items-center justify-center bg-ink-950">
        <div className="k-bg-grid absolute inset-0" aria-hidden="true" />
        <span className="k-live-dot relative" />
      </div>
    );
  }

  if (state.phase === "offline") {
    return (
      <div className="relative flex h-screen items-center justify-center bg-ink-950 px-4">
        <div className="k-bg-grid absolute inset-0" aria-hidden="true" />
        <div className="k-window relative w-[30rem] p-6">
          <h1 className="font-display text-lg font-bold tracking-wide text-mist">
            Can't reach the API.
          </h1>
          <div className="mt-3">
            <ErrorAlert error={state.error} />
          </div>
          <p className="mt-3 font-mono text-[11px] leading-relaxed text-mist-faint">
            Start (or restart) Kinglet, then retry. Boot failures — including failed schema
            migrations — print in full in the server terminal.
          </p>
          <Button
            size="sm"
            className="mt-4"
            onClick={() => {
              setState({ phase: "loading" });
              void load();
            }}
          >
            retry
          </Button>
        </div>
      </div>
    );
  }

  if (state.phase === "login") {
    return <Login error={state.error} onSuccess={() => void load()} />;
  }

  const value: AppContextValue = {
    user: state.user,
    permissions: state.permissions,
    projects: state.projects,
    currentProjectId: state.currentProjectId,
    setProjectId: (id) => {
      localStorage.setItem("kinglet.project", String(id));
      setState((prev) => (prev.phase === "ready" ? { ...prev, currentProjectId: id } : prev));
    },
    refreshProjects: async () => {
      try {
        const { projects } = await fetchProjects();
        setState((prev) => {
          if (prev.phase !== "ready") return prev;
          const stillExists = projects.some((p) => p.id === prev.currentProjectId);

          const currentProjectId = stillExists
            ? prev.currentProjectId
            : (projects[0]?.id ?? prev.currentProjectId);

          if (currentProjectId !== prev.currentProjectId) {
            writeLocal(PROJECT_STORAGE_KEY, currentProjectId);
          }

          return { ...prev, projects, currentProjectId };
        });
      } catch {
        // ignore — the list refreshes on the next load
      }
    },
    signOut: () => {
      // Never pretend a failed sign-out succeeded: the HttpOnly session
      // cookie is only cleared by the server.
      void logout()
        .then(() => {
          clearLocalState();
          toast.dismiss();
          setState({ phase: "login" });

          return undefined;
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : "could not sign out";
          toast.error("Sign-out failed", {
            description: `${message}. Your session is still active — check that KINGLET_BASE_URL matches this origin.`,
          });

          return undefined;
        });
    },
  };

  // The admin event feed is the only source of live backup/restore/archive
  // progress. Gate it on the role: the server endpoint is admin-only, and a
  // member's connection would just fail and reconnect.
  const isAdmin = state.user.role === "admin";

  return (
    <AppContext.Provider value={value}>
      {isAdmin ? (
        <SystemEventsProvider>
          <Outlet />
        </SystemEventsProvider>
      ) : (
        <Outlet />
      )}
    </AppContext.Provider>
  );
}
