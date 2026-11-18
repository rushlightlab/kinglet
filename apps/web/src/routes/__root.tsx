import { useCallback, useEffect, useState } from "react";
import { createRootRoute, Outlet } from "@tanstack/react-router";
import { fetchMe, fetchProjects, logout, UnauthorizedError } from "../api";
import { AppContext } from "../app-context";
import type { AppContextValue } from "../app-context";
import Login from "../components/Login";
import type { AppUser, Project } from "../types";

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
      currentProjectId: number;
      signOutError?: string;
    };

function RootComponent() {
  const [state, setState] = useState<RootState>({ phase: "loading" });

  const load = useCallback(async () => {
    try {
      const me = await fetchMe();
      const { projects } = await fetchProjects();
      const storedRaw = Number(localStorage.getItem("kinglet.project"));
      const urlRaw = Number(new URLSearchParams(window.location.search).get("project"));
      const valid = (id: number): boolean =>
        Number.isFinite(id) && id > 0 && projects.some((p) => p.id === id);
      const chosen = [urlRaw, storedRaw].find(valid) ?? projects[0]?.id;
      if (chosen === undefined) {
        setState({ phase: "offline", error: "The API is up, but no projects exist yet — check the server logs." });
        return;
      }
      localStorage.setItem("kinglet.project", String(chosen));
      setState({
        phase: "ready",
        user: me.user,
        permissions: me.permissions,
        projects,
        currentProjectId: chosen,
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
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
          <h1 className="font-display text-lg font-bold tracking-wide text-mist">Can't reach the API.</h1>
          <p className="mt-2 break-words font-mono text-xs leading-relaxed text-mist-dim">{state.error}</p>
          <p className="mt-3 font-mono text-[11px] leading-relaxed text-mist-faint">
            Start (or restart) Kinglet, then retry. Boot failures — including failed schema
            migrations — print in full in the server terminal.
          </p>
          <button
            onClick={() => {
              setState({ phase: "loading" });
              void load();
            }}
            className="k-btn k-btn-primary k-btn-sm mt-4"
          >
            retry
          </button>
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
        setState((prev) => (prev.phase === "ready" ? { ...prev, projects } : prev));
      } catch {
        // ignore — the list refreshes on the next load
      }
    },
    signOut: () => {
      // Never pretend a failed sign-out succeeded: the HttpOnly session
      // cookie is only cleared by the server.
      setState((prev) => (prev.phase === "ready" ? { ...prev, signOutError: undefined } : prev));
      void logout()
        .then(() => setState({ phase: "login" }))
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : "could not sign out";
          setState((prev) => (prev.phase === "ready" ? { ...prev, signOutError: message } : prev));
        });
    },
  };

  return (
    <AppContext.Provider value={value}>
      <Outlet />
      {state.signOutError && (
        <div className="fixed bottom-4 left-1/2 z-50 w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 rounded-[5px] border border-coral/30 bg-ink-900 px-4 py-3 font-mono text-xs text-coral shadow-lg">
          Sign-out failed: {state.signOutError}. Your session is still active — clear cookies for
          this site or check that <span className="text-mist">KINGLET_BASE_URL</span> matches this
          origin.
        </div>
      )}
    </AppContext.Provider>
  );
}
