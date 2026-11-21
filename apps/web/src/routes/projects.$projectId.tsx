import { useEffect } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useApp, hasPermission } from "../app-context";
import PageShell from "../components/PageShell";
import ClearLogsCard from "../components/settings/ClearLogsCard";
import KeysCard from "../components/settings/KeysCard";
import MembersCard from "../components/settings/MembersCard";
import { ProjectDangerCard, ProjectRenameCard } from "../components/settings/ProjectAdminCard";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/projects/$projectId")({
  component: ProjectSettingsPage,
});

function ProjectSettingsPage() {
  const { projectId } = Route.useParams();
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

  return (
    <PageShell
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

      <div className="mt-3 flex flex-col gap-3">
        {canWriteProjects && <ProjectRenameCard project={project} />}
        {canReadKeys && <KeysCard projectId={project.id} projectName={project.name} />}
        {canWriteProjects && <MembersCard projectId={project.id} projectName={project.name} />}
        <ClearLogsCard
          projectId={project.id}
          projectName={project.name}
          canClear={project.canClearLogs}
        />
        {canWriteProjects && <ProjectDangerCard project={project} />}

        {!canManage && (
          <Card>
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
      </div>
    </PageShell>
  );
}
