import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { hasPermissionOrAdmin, useApp } from "../app-context";
import { isString } from "../json";
import PageShell from "../components/PageShell";
import AccountPanel from "../components/settings/AccountPanel";
import BackupsPanel from "../components/settings/BackupsPanel";
import NotificationsPanel from "../components/settings/NotificationsPanel";
import ProjectsPanel from "../components/settings/ProjectsPanel";
import UsersPanel from "../components/settings/UsersPanel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface SettingsSearch {
  tab?: string;
}

export const Route = createFileRoute("/settings")({
  validateSearch: (search): SettingsSearch => ({
    tab: isString(search.tab) ? search.tab : undefined,
  }),
  component: SettingsPage,
});

type Tab = "projects" | "users" | "backups" | "notifications" | "account";

const TABS: readonly Tab[] = ["projects", "users", "backups", "notifications", "account"];

function isTab(value: string | undefined): value is Tab {
  return TABS.some((tab) => tab === value);
}

function SettingsPage() {
  const { user, permissions } = useApp();
  const search = Route.useSearch();
  const navigate = useNavigate();

  // Admin fallback: the role mapping is authoritative, but the permission
  // list can briefly lag during an API upgrade.
  const canUsers = hasPermissionOrAdmin(user.role, permissions, "users.read");
  const canBackups = hasPermissionOrAdmin(user.role, permissions, "backups.read");
  const canNotifications = hasPermissionOrAdmin(user.role, permissions, "notifications.read");

  const available: Tab[] = ["projects"];

  if (canUsers) available.push("users");

  if (canBackups) available.push("backups");

  if (canNotifications) available.push("notifications");

  // Everyone has an account, so the tabs always show.
  available.push("account");

  const requested = isTab(search.tab) ? search.tab : "projects";
  const tab = available.includes(requested) ? requested : "projects";

  const selectTab = (value: Tab): void => {
    void navigate({
      to: "/settings",
      search: { tab: value },
      replace: true,
    });
  };

  return (
    <PageShell
      wide
      kicker="settings"
      title="Workspace."
      description="Projects, people, backups, and notification channels across this Kinglet instance, and your own account."
    >
      <Tabs
        value={tab}
        onValueChange={(value) => {
          if (isTab(value)) selectTab(value);
        }}
        className="mt-6 gap-4"
      >
        <TabsList className="overflow-x-auto">
          <TabsTrigger value="projects">projects</TabsTrigger>
          {canUsers && <TabsTrigger value="users">users</TabsTrigger>}
          {canBackups && <TabsTrigger value="backups">backups</TabsTrigger>}
          {canNotifications && <TabsTrigger value="notifications">notifications</TabsTrigger>}
          <TabsTrigger value="account">my account</TabsTrigger>
        </TabsList>
        <TabsContent value="projects">
          <ProjectsPanel />
        </TabsContent>
        {canUsers && (
          <TabsContent value="users">
            <UsersPanel />
          </TabsContent>
        )}
        {canBackups && (
          <TabsContent value="backups">
            <BackupsPanel />
          </TabsContent>
        )}
        {canNotifications && (
          <TabsContent value="notifications">
            <NotificationsPanel />
          </TabsContent>
        )}
        <TabsContent value="account">
          <AccountPanel />
        </TabsContent>
      </Tabs>
    </PageShell>
  );
}
