import { useEffect } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useApp, hasPermission } from "../app-context";
import { isString } from "../json";
import PageShell from "../components/PageShell";
import ClearLogsCard from "../components/settings/ClearLogsCard";
import KeysCard from "../components/settings/KeysCard";
import MembersCard from "../components/settings/MembersCard";
import { ProjectDangerCard, ProjectRenameCard } from "../components/settings/ProjectAdminCard";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface ProjectSearch {
  tab?: string;
}

export const Route = createFileRoute("/projects/$projectId")({
  validateSearch: (search): ProjectSearch => ({
    tab: isString(search.tab) ? search.tab : undefined,
  }),
  component: ProjectSettingsPage,
});

type Tab = "keys" | "members" | "general";

function isTab(value: string | undefined): value is Tab {
  return value === "keys" || value === "members" || value === "general";
}

function ProjectSettingsPage() {
  const { projectId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const { projects, currentProjectId, setProjectId, permissions } = useApp();
  const project = projects.find((item) => item.id === projectId);

  useEffect(() => {
    if (project && project.id !== currentProjectId) setProjectId(project.id);
  }, [project, currentProjectId, setProjectId]);

  if (!project) {
    return (
      <PageShell
        kicker="project settings"
        title="Project not found."
        description="It may have been deleted, or your account may not have access to it."
      >
        <Button variant="outline" size="sm" className="mt-6" asChild>
          <Link to="/settings">back to workspace</Link>
        </Button>
      </PageShell>
    );
  }

  const canWriteProjects = hasPermission(permissions, "projects.write");
  const canReadKeys = hasPermission(permissions, "keys.read");
  const canManage = canWriteProjects || canReadKeys || project.canClearLogs;

  // "general" holds rename, clear logs, and delete; each card checks its own access.
  const available: Tab[] = [];

  if (canReadKeys) available.push("keys");

  if (canWriteProjects) available.push("members");

  if (canWriteProjects || project.canClearLogs) available.push("general");

  const tab = isTab(search.tab) && available.includes(search.tab) ? search.tab : available[0];

  const general = (
    <div className="flex flex-col gap-3">
      {canWriteProjects && <ProjectRenameCard project={project} />}
      <ClearLogsCard
        projectId={project.id}
        projectName={project.name}
        canClear={project.canClearLogs}
      />
      {canWriteProjects && <ProjectDangerCard project={project} />}
    </div>
  );

  return (
    <PageShell
      wide
      kicker="project settings"
      title={`${project.name}.`}
      description="API keys, members, clear-log access, and lifecycle for this project."
    >
      <div className="mt-5 flex items-center gap-2 font-mono text-[10px] text-mist-faint">
        <Link to="/settings" className="transition-colors hover:text-gold">
          workspace
        </Link>
        <span aria-hidden="true">/</span>
        <span className="text-mist-dim">{project.name}</span>
      </div>

      {!canManage && (
        <Card className="mt-3">
          <CardHeader>
            <CardTitle>Read-only project</CardTitle>
            <CardDescription>
              Your role can view logs from this project but cannot manage its keys, members, or
              retention.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" size="sm" asChild>
              <Link to="/" search={{ q: undefined, from: undefined, to: undefined }}>
                open logs
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {available.length === 1 && tab === "general" && <div className="mt-3">{general}</div>}

      {available.length > 1 && tab !== undefined && (
        <Tabs
          value={tab}
          onValueChange={(value) => {
            if (!isTab(value)) return;
            void navigate({
              to: "/projects/$projectId",
              params: { projectId: project.id },
              search: { tab: value },
              replace: true,
            });
          }}
          className="mt-4 gap-4"
        >
          <TabsList className="overflow-x-auto">
            {canReadKeys && <TabsTrigger value="keys">keys</TabsTrigger>}
            {canWriteProjects && <TabsTrigger value="members">members</TabsTrigger>}
            <TabsTrigger value="general">general</TabsTrigger>
          </TabsList>
          {canReadKeys && (
            <TabsContent value="keys">
              <KeysCard projectId={project.id} />
            </TabsContent>
          )}
          {canWriteProjects && (
            <TabsContent value="members">
              <MembersCard projectId={project.id} />
            </TabsContent>
          )}
          <TabsContent value="general">{general}</TabsContent>
        </Tabs>
      )}

      {available.length === 1 && tab === "keys" && (
        <div className="mt-3">
          <KeysCard projectId={project.id} />
        </div>
      )}
    </PageShell>
  );
}
