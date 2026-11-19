import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { hasPermission, useApp } from "../app-context";
import PageShell from "../components/PageShell";
import ProjectsPanel from "../components/settings/ProjectsPanel";
import UsersPanel from "../components/settings/UsersPanel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

type Tab = "projects" | "users";

function SettingsPage() {
  const { permissions } = useApp();
  const canUsers = hasPermission(permissions, "users.read");
  const [tab, setTab] = useState<Tab>("projects");

  return (
    <PageShell
      kicker="settings"
      title="Workspace."
      description="Projects and people across this Kinglet instance."
    >
      {canUsers ? (
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as Tab)}
          className="mt-6 gap-4"
        >
          <TabsList>
            <TabsTrigger value="projects">projects</TabsTrigger>
            <TabsTrigger value="users">users</TabsTrigger>
          </TabsList>
          <TabsContent value="projects">
            <ProjectsPanel />
          </TabsContent>
          <TabsContent value="users">
            <UsersPanel />
          </TabsContent>
        </Tabs>
      ) : (
        <div className="mt-6">
          <ProjectsPanel />
        </div>
      )}
    </PageShell>
  );
}
