import { createContext, useContext } from "react";
import type { AppUser, Project } from "./types";

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
