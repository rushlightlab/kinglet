import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { deleteProject, renameProject } from "../../api";
import { useApp } from "../../app-context";
import type { Project } from "../../types";
import ErrorAlert from "../ErrorAlert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

export function ProjectRenameCard({ project }: { project: Project }) {
  const { refreshProjects } = useApp();
  const [name, setName] = useState(project.name);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(project.name);
  }, [project.name]);

  const saveName = async (): Promise<void> => {
    const next = name.trim();
    if (!next || next === project.name) return;
    setSaving(true);
    try {
      await renameProject(project.id, next);
      await refreshProjects();
      setError(null);
      toast.success("Project renamed");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <ErrorAlert error={error} />

      <Card>
        <CardHeader>
          <CardTitle>Project details</CardTitle>
          <CardDescription>
            Rename this project. Its keys, logs, and monitors stay attached.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void saveName();
            }}
          >
            <Field className="min-w-48 flex-1">
              <FieldLabel htmlFor="project-rename">project name</FieldLabel>
              <Input
                id="project-rename"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="off"
              />
            </Field>
            <Button
              type="submit"
              disabled={saving || !name.trim() || name.trim() === project.name}
            >
              {saving && <Spinner data-icon="inline-start" />}
              save name
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

export function ProjectDangerCard({ project }: { project: Project }) {
  const { projects, refreshProjects } = useApp();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const isOnlyProject = projects.length <= 1;

  const remove = async (): Promise<void> => {
    setDeleting(true);
    try {
      await deleteProject(project.id);
      await refreshProjects();
      toast.success("Project deleted");
      void navigate({ to: "/settings" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <ErrorAlert error={error} />

      <Card>
        <CardHeader>
          <CardTitle>Delete project</CardTitle>
          <CardDescription>
            Every log, key, and monitor in this project is removed. This cannot be undone.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="destructive"
                size="sm"
                disabled={isOnlyProject || deleting}
                title={isOnlyProject ? "The only project cannot be deleted" : undefined}
              >
                <Trash2Icon data-icon="inline-start" />
                delete project
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {project.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  Every log, key, and monitor in this project is deleted. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  disabled={deleting}
                  onClick={(event) => {
                    event.preventDefault();
                    void remove();
                  }}
                >
                  {deleting && <Spinner data-icon="inline-start" />}
                  Delete project
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          {isOnlyProject && (
            <p className="font-mono text-[10px] text-mist-faint">
              This is the only project, so it cannot be deleted.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
