import { createContext, useContext } from "react";
import type { AppUser, Project, UserRole } from "./types";

export interface AppContextValue {
  user: AppUser;
  permissions: string[];
  projects: Project[];
  currentProjectId: string;
  setProjectId: (id: string) => void;
  refreshProjects: () => Promise<void>;
  signOut: () => void;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);

  if (!value) throw new Error("useApp must be used inside <AppContext.Provider>");

  return value;
}

export function hasPermission(permissions: string[], permission: string): boolean {
  return permissions.includes(permission);
}

/**
 * Admin-only surfaces are gated by role as well as by the permission list.
 * The server role mapping is authoritative, but a stale `/v1/me` payload (or
 * a deployment mid-upgrade) must not hide Settings tabs from an admin.
 */
export function hasPermissionOrAdmin(
  role: UserRole,
  permissions: string[],
  permission: string,
): boolean {
  return role === "admin" || hasPermission(permissions, permission);
}
