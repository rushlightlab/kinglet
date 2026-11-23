import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { toast } from "sonner";
import { createProject, fetchProjects } from "../../api";
import type { PageQuery } from "../../api";
import { hasPermission, useApp } from "../../app-context";
import type { Project } from "../../types";
import ErrorAlert from "../ErrorAlert";
import SkeletonRows from "../SkeletonRows";
import TablePagination from "../TablePagination";
import TableSearch, { NoMatchesRow } from "../TableSearch";
import { fadeWhileLoading, useServerTable } from "../../server-table";
import type { TablePage } from "../../server-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

async function loadProjectPage(page: PageQuery): Promise<TablePage<Project>> {
  const result = await fetchProjects(page);

  return { rows: result.projects, total: result.total };
}

export default function ProjectsPanel() {
  const { currentProjectId, permissions, refreshProjects } = useApp();
  const canWriteProjects = hasPermission(permissions, "projects.write");
  const canReadKeys = hasPermission(permissions, "keys.read");
  const projectTable = useServerTable("projects", loadProjectPage);
  const [name, setName] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const create = async (): Promise<void> => {
    if (!name.trim()) return;

    try {
      await createProject(name.trim());
      setName("");
      setFormError(null);
      setAddOpen(false);
      // The project switcher reads the app's list; the table reads its page.
      await Promise.all([refreshProjects(), projectTable.reload()]);
      toast.success("Project created");
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <ErrorAlert error={projectTable.error} />

      <Card>
        <CardHeader>
          <CardTitle>Projects</CardTitle>
          <CardDescription>
            Each project has its own logs, keys, and monitors. Open one to manage it.
          </CardDescription>
          <CardAction className="row-span-1 flex items-center gap-2 self-center">
            <TableSearch
              label="Search projects"
              value={projectTable.query}
              onChange={projectTable.setQuery}
            />
            {canWriteProjects && (
              <Button size="sm" className="shrink-0" onClick={() => setAddOpen(true)}>
                <PlusIcon data-icon="inline-start" />
                new project
              </Button>
            )}
          </CardAction>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>project</TableHead>
                <TableHead className="hidden sm:table-cell">created</TableHead>
                <TableHead className="text-right">actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className={fadeWhileLoading(projectTable)}>
              {!projectTable.loaded && <SkeletonRows columns={3} label="Loading projects…" />}
              {projectTable.rows.map((project) => {
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
              {projectTable.loaded && projectTable.total === 0 && (
                <NoMatchesRow
                  columns={3}
                  query={projectTable.activeQuery}
                  noun="projects"
                  onClear={() => projectTable.setQuery("")}
                />
              )}
            </TableBody>
          </Table>
        </CardContent>
        <TablePagination table={projectTable} noun="projects" className="-mb-4" />
      </Card>

      <Dialog
        open={addOpen}
        onOpenChange={(open) => {
          setAddOpen(open);

          if (!open) setFormError(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <DialogHeader>
              <DialogTitle>New project</DialogTitle>
              <DialogDescription>
                A project keeps its own logs, keys, monitors, and members.
              </DialogDescription>
            </DialogHeader>
            <Field className="mt-4">
              <FieldLabel htmlFor="project-name">name</FieldLabel>
              <Input
                id="project-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="production"
              />
            </Field>
            {formError && (
              <p className="mt-2 font-mono text-[11px] text-coral" role="alert">
                {formError}
              </p>
            )}
            <DialogFooter className="mt-4">
              <Button variant="outline" size="sm" type="button" onClick={() => setAddOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={!name.trim()}>
                <PlusIcon data-icon="inline-start" />
                Create project
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
