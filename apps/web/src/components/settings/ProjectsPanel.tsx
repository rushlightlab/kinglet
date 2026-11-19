import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { toast } from "sonner";
import { createProject } from "../../api";
import { hasPermission, useApp } from "../../app-context";
import ErrorAlert from "../ErrorAlert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export default function ProjectsPanel() {
  const { projects, currentProjectId, permissions, refreshProjects } = useApp();
  const canWriteProjects = hasPermission(permissions, "projects.write");
  const canReadKeys = hasPermission(permissions, "keys.read");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = async (): Promise<void> => {
    if (!name.trim()) return;
    try {
      await createProject(name.trim());
      setName("");
      await refreshProjects();
      toast.success("Project created");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <ErrorAlert error={error} />

      <Card>
        <CardHeader>
          <CardTitle>Projects</CardTitle>
          <CardDescription>
            Each project has its own logs, keys, and monitors. Open one to manage it.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>project</TableHead>
                <TableHead className="hidden sm:table-cell">created</TableHead>
                <TableHead className="text-right">actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projects.map((project) => {
                const canManage = canWriteProjects || canReadKeys || project.canClearLogs;
                return (
                  <TableRow key={project.id}>
                    <TableCell>
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-mist">{project.name}</span>
                        {project.id === currentProjectId && (
                          <Badge className="text-[9px] normal-case tracking-normal">current</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="hidden text-[10px] text-mist-faint sm:table-cell">
                      {new Date(project.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-right">
                      {canManage ? (
                        <Button variant="outline" size="xs" asChild>
                          <Link to="/projects/$projectId" params={{ projectId: project.id }}>
                            manage
                          </Link>
                        </Button>
                      ) : (
                        <span className="font-mono text-[10px] text-mist-faint">read only</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>

          {canWriteProjects && (
            <form
              className="flex flex-wrap items-end gap-3 border-t border-white/[0.06] pt-4"
              onSubmit={(event) => {
                event.preventDefault();
                void create();
              }}
            >
              <Field className="min-w-40 flex-1">
                <FieldLabel htmlFor="project-name">new project</FieldLabel>
                <Input
                  id="project-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="production"
                />
              </Field>
              <Button type="submit" variant="outline" disabled={!name.trim()}>
                <PlusIcon data-icon="inline-start" />
                add project
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
