import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import {
  BanIcon,
  BarChart3Icon,
  CircleCheckIcon,
  KeyRoundIcon,
  MoreHorizontalIcon,
  PlusIcon,
  RotateCcwIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
  UserCogIcon,
  UserPlusIcon,
} from "lucide-react";
import { toast } from "sonner";
import {
  addProjectMember,
  changePassword,
  clearProjectLogs,
  createKey,
  createProject,
  createUser,
  deleteKey,
  deleteProject,
  deleteUser,
  fetchKeys,
  fetchProjectMembers,
  fetchUsers,
  removeProjectMember,
  resetUserPassword,
  rotateKey,
  updateKeyScopes,
  updateProjectMember,
  updateUser,
} from "../api";
import { hasPermission, useApp } from "../app-context";
import type { ApiKeyInfo, AppUser, ProjectMember } from "../types";
import CopyButton from "../components/CopyButton";
import ErrorAlert from "../components/ErrorAlert";
import PageShell from "../components/PageShell";
import PasswordInput from "../components/PasswordInput";
import PasswordRequirements from "../components/PasswordRequirements";
import { passwordProblem } from "../lib/password";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

type Tab = "keys" | "users" | "account";

function SettingsPage() {
  const { permissions } = useApp();
  const canKeys = hasPermission(permissions, "keys.read");
  const canUsers = hasPermission(permissions, "users.read");
  const [tab, setTab] = useState<Tab>(canKeys ? "keys" : canUsers ? "users" : "account");

  const tabs: { id: Tab; label: string; visible: boolean }[] = [
    { id: "keys", label: "projects & keys", visible: canKeys },
    { id: "users", label: "users", visible: canUsers },
    { id: "account", label: "account", visible: true },
  ];

  return (
    <PageShell kicker="settings" title="Workspace.">
      <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)} className="mt-6">
        <TabsList>
          {tabs
            .filter((t) => t.visible)
            .map((t) => (
              <TabsTrigger key={t.id} value={t.id}>
                {t.label}
              </TabsTrigger>
            ))}
        </TabsList>

        {tab === "keys" && canKeys && (
          <TabsContent value="keys">
            <KeysPanel />
          </TabsContent>
        )}
        {tab === "users" && canUsers && (
          <TabsContent value="users">
            <UsersPanel />
          </TabsContent>
        )}
        {tab === "account" && (
          <TabsContent value="account">
            <AccountPanel />
          </TabsContent>
        )}
      </Tabs>
    </PageShell>
  );
}

// ---------- projects + API keys ----------

function KeysPanel() {
  const { currentProjectId, projects, permissions, refreshProjects } = useApp();
  const navigate = useNavigate();
  const canWriteKeys = hasPermission(permissions, "keys.write");
  const canWriteProjects = hasPermission(permissions, "projects.write");
  const project = projects.find((p) => p.id === currentProjectId);

  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [scopeIngest, setScopeIngest] = useState(true);
  const [scopeQuery, setScopeQuery] = useState(true);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingKey, setPendingKey] = useState<{
    type: "revoke" | "rotate";
    key: ApiKeyInfo;
  } | null>(null);
  const [editKey, setEditKey] = useState<ApiKeyInfo | null>(null);
  const [editIngest, setEditIngest] = useState(true);
  const [editQuery, setEditQuery] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);

  const [projectName, setProjectName] = useState("");
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [allUsers, setAllUsers] = useState<AppUser[]>([]);
  const [memberToAdd, setMemberToAdd] = useState("");

  const load = useCallback(async () => {
    try {
      setKeys((await fetchKeys(currentProjectId)).keys);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [currentProjectId]);

  useEffect(() => {
    setCreatedKey(null);
    void load();
  }, [load]);

  const loadMembers = useCallback(async () => {
    if (!canWriteProjects) return;
    try {
      const [m, u] = await Promise.all([fetchProjectMembers(currentProjectId), fetchUsers()]);
      setMembers(m.members);
      setAllUsers(u.users);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [currentProjectId, canWriteProjects]);

  useEffect(() => {
    setMemberToAdd("");
    void loadMembers();
  }, [loadMembers]);

  const eligibleUsers = allUsers.filter((u) => u.role !== "admin");
  const candidates = eligibleUsers.filter(
    (u) => !members.some((m) => m.userId === u.id)
  );
  const memberEmptyMessage =
    eligibleUsers.length === 0
      ? "No member accounts yet. Create one under the Users tab."
      : "No members assigned yet.";

  const addMember = async (): Promise<void> => {
    if (!memberToAdd) return;
    try {
      await addProjectMember(currentProjectId, memberToAdd);
      setMemberToAdd("");
      await loadMembers();
      toast.success("Member added");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const removeMember = async (userId: string): Promise<void> => {
    try {
      await removeProjectMember(currentProjectId, userId);
      await loadMembers();
      toast.success("Member removed");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const setMemberClearLogs = async (
    member: ProjectMember,
    canClearLogs: boolean
  ): Promise<void> => {
    try {
      await updateProjectMember(currentProjectId, member.userId, { canClearLogs });
      await loadMembers();
      toast.success(
        canClearLogs
          ? `Allowed ${member.email} to clear logs`
          : `Revoked clear logs from ${member.email}`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const create = async (): Promise<void> => {
    const scopes = [scopeIngest ? "ingest" : null, scopeQuery ? "query" : null].filter(
      (s): s is string => s !== null
    );
    if (!name.trim() || scopes.length === 0) return;
    setBusy(true);
    try {
      const result = await createKey(currentProjectId, { name: name.trim(), scopes });
      setCreatedKey(result.plaintext);
      setName("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const openKeyScopes = (key: ApiKeyInfo): void => {
    setEditKey(key);
    setEditIngest(key.scopes.includes("ingest"));
    setEditQuery(key.scopes.includes("query"));
  };

  const saveKeyScopes = async (): Promise<void> => {
    if (!editKey) return;
    const scopes = [editIngest ? "ingest" : null, editQuery ? "query" : null].filter(
      (scope): scope is string => scope !== null
    );
    if (scopes.length === 0) return;
    setActionBusy(true);
    try {
      await updateKeyScopes(editKey.id, currentProjectId, scopes);
      await load();
      setEditKey(null);
      toast.success("Key permissions updated");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setEditKey(null);
    } finally {
      setActionBusy(false);
    }
  };

  const runKeyAction = async (): Promise<void> => {
    if (!pendingKey) return;
    setActionBusy(true);
    try {
      if (pendingKey.type === "rotate") {
        const rotated = await rotateKey(pendingKey.key.id, currentProjectId);
        setCreatedKey(rotated.plaintext);
        toast.success("Key rerolled");
      } else {
        await deleteKey(pendingKey.key.id, currentProjectId);
        toast.success("Key revoked");
      }
      await load();
      setPendingKey(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPendingKey(null);
    } finally {
      setActionBusy(false);
    }
  };

  const addProject = async (): Promise<void> => {
    if (!projectName.trim()) return;
    try {
      await createProject(projectName.trim());
      setProjectName("");
      await refreshProjects();
      toast.success("Project created");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const removeProject = async (): Promise<void> => {
    try {
      await deleteProject(currentProjectId);
      await refreshProjects();
      toast.success("Project deleted");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="mt-5 flex flex-col gap-3">
      <ErrorAlert error={error} />

      <Card>
        <CardHeader>
          <CardTitle>API keys — {project?.name ?? "project"}</CardTitle>
          <CardDescription>
            Keys are machine credentials: <span className="text-gold">ingest</span> writes logs,{" "}
            <span className="text-gold">query</span> reads them. The full key is shown once.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {createdKey && (
            <Alert variant="gold">
              <KeyRoundIcon />
              <AlertTitle>Copy this key now — it won&apos;t be shown again</AlertTitle>
              <AlertDescription>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <code className="break-all rounded-[3px] bg-ink-900 px-2 py-1 text-mist">
                    {createdKey}
                  </code>
                  <CopyButton value={createdKey} />
                </div>
              </AlertDescription>
            </Alert>
          )}

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>name</TableHead>
                <TableHead>token</TableHead>
                <TableHead>scopes</TableHead>
                <TableHead className="hidden md:table-cell">last used</TableHead>
                <TableHead className="hidden md:table-cell">created</TableHead>
                <TableHead className="text-right">actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((key) => (
                <TableRow key={key.id}>
                  <TableCell className="text-mist">{key.name}</TableCell>
                  <TableCell>
                    <span
                      className="inline-flex items-center rounded-[3px] border border-white/[0.08] bg-white/[0.025] px-1.5 py-0.5 font-mono text-[10px] text-mist-dim"
                      title={`key:${key.id}`}
                    >
                      {key.prefix}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {key.scopes.map((scope) => (
                        <Badge key={scope}>{scope}</Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-[10px] text-mist-faint">
                    {key.lastUsedAt
                      ? new Date(key.lastUsedAt).toLocaleDateString()
                      : "No activity"}
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-[10px] text-mist-dim">
                        {key.createdByEmail ?? "—"}
                      </span>
                      <span className="text-[10px] text-mist-faint">
                        {new Date(key.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Actions for ${key.name}`}
                        >
                          <MoreHorizontalIcon />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuLabel>Key actions</DropdownMenuLabel>
                        <DropdownMenuGroup>
                          <DropdownMenuItem
                            onSelect={() =>
                              void navigate({
                                to: "/",
                                search: { q: `key:${key.id}`, from: undefined, to: undefined },
                              })
                            }
                          >
                            <BarChart3Icon />
                            View usage
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={!canWriteKeys}
                            onSelect={() => openKeyScopes(key)}
                          >
                            <SlidersHorizontalIcon />
                            Edit permissions
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={!canWriteKeys}
                            onSelect={() => setPendingKey({ type: "rotate", key })}
                          >
                            <RotateCcwIcon />
                            Reroll key
                          </DropdownMenuItem>
                        </DropdownMenuGroup>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          disabled={!canWriteKeys}
                          onSelect={() => setPendingKey({ type: "revoke", key })}
                        >
                          <Trash2Icon />
                          Revoke key
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
              {keys.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-4 text-center text-mist-faint">
                    No keys for this project yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>

          {canWriteKeys && (
            <form
              className="flex flex-wrap items-end gap-3 border-t border-white/[0.06] pt-4"
              onSubmit={(event) => {
                event.preventDefault();
                void create();
              }}
            >
              <Field className="min-w-40 flex-1">
                <FieldLabel htmlFor="key-name">key name</FieldLabel>
                <Input
                  id="key-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="production-ingest"
                />
              </Field>
              <Field orientation="horizontal" className="h-9 w-auto">
                <Checkbox
                  id="scope-ingest"
                  aria-label="ingest"
                  checked={scopeIngest}
                  onCheckedChange={(checked) => setScopeIngest(checked === true)}
                />
                <FieldLabel
                  htmlFor="scope-ingest"
                  className="normal-case tracking-normal text-xs text-mist-dim"
                >
                  ingest
                </FieldLabel>
              </Field>
              <Field orientation="horizontal" className="h-9 w-auto">
                <Checkbox
                  id="scope-query"
                  aria-label="query"
                  checked={scopeQuery}
                  onCheckedChange={(checked) => setScopeQuery(checked === true)}
                />
                <FieldLabel
                  htmlFor="scope-query"
                  className="normal-case tracking-normal text-xs text-mist-dim"
                >
                  query
                </FieldLabel>
              </Field>
              <Button
                type="submit"
                size="sm"
                className="h-9"
                disabled={busy || !name.trim() || (!scopeIngest && !scopeQuery)}
              >
                <PlusIcon data-icon="inline-start" />
                create key
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Projects</CardTitle>
          <CardDescription>Each project has its own logs, keys, and monitors.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            {projects.map((p) => (
              <Badge key={p.id} variant={p.id === currentProjectId ? "default" : "outline"}>
                {p.name}
              </Badge>
            ))}
          </div>

          {canWriteProjects && (
            <div className="border-t border-white/[0.06] pt-4">
              <FieldLabel>members — {project?.name ?? "project"}</FieldLabel>
              <p className="mt-1 font-mono text-[10px] leading-relaxed text-mist-faint">
                Admins see every project. Members and viewers see only the projects assigned here.
              </p>
              <div className="mt-3">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>member</TableHead>
                      <TableHead>role</TableHead>
                      <TableHead>clear logs</TableHead>
                      <TableHead className="text-right">actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {members.map((m) => (
                      <TableRow key={m.userId}>
                        <TableCell className="max-w-56 truncate text-mist">{m.email}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{m.role}</Badge>
                        </TableCell>
                        <TableCell>
                          <Switch
                            checked={m.canClearLogs}
                            onCheckedChange={(checked) => void setMemberClearLogs(m, checked)}
                            disabled={m.role === "viewer"}
                            title={
                              m.role === "viewer"
                                ? "Viewers cannot be granted clear logs"
                                : m.canClearLogs
                                  ? "Revoke clear logs"
                                  : "Allow clear logs"
                            }
                            aria-label={`Allow ${m.email} to clear logs`}
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button variant="destructive" size="xs">
                                remove
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Remove {m.email}?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  They will lose access to this project immediately.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction
                                  variant="destructive"
                                  onClick={() => void removeMember(m.userId)}
                                >
                                  Remove member
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </TableCell>
                      </TableRow>
                    ))}
                    {members.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={4} className="py-4 text-center text-mist-faint">
                          {memberEmptyMessage}
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
              {candidates.length > 0 ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Select value={memberToAdd} onValueChange={setMemberToAdd}>
                    <SelectTrigger className="w-64">
                      <SelectValue placeholder="Select a user" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectLabel>Available users</SelectLabel>
                        {candidates.map((u) => (
                          <SelectItem key={u.id} value={u.id}>
                            {u.email}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-9"
                    disabled={!memberToAdd}
                    onClick={() => void addMember()}
                  >
                    <UserPlusIcon data-icon="inline-start" />
                    add member
                  </Button>
                </div>
              ) : (
                members.length > 0 && (
                  <p className="mt-3 font-mono text-[10px] text-mist-faint">
                    Every member account is already assigned to this project.
                  </p>
                )
              )}
            </div>
          )}

          {canWriteProjects && (
            <form
              className="flex flex-wrap items-end gap-3 border-t border-white/[0.06] pt-4"
              onSubmit={(event) => {
                event.preventDefault();
                void addProject();
              }}
            >
              <Field className="min-w-40 flex-1">
                <FieldLabel htmlFor="project-name">new project</FieldLabel>
                <Input
                  id="project-name"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder="production"
                />
              </Field>
              <Button type="submit" variant="outline" size="sm" className="h-9" disabled={!projectName.trim()}>
                <PlusIcon data-icon="inline-start" />
                add project
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button type="button" variant="destructive" size="sm" className="h-9">
                    <Trash2Icon data-icon="inline-start" />
                    delete current project
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete {project?.name ?? "this project"}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Every log, key, and monitor in this project is deleted. This cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction variant="destructive" onClick={() => void removeProject()}>
                      Delete project
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </form>
          )}
        </CardContent>
      </Card>

      <ClearLogsCard
        projectId={currentProjectId}
        projectName={project?.name ?? "this project"}
        canClear={project?.canClearLogs === true}
      />

      <AlertDialog
        open={pendingKey !== null}
        onOpenChange={(open) => {
          if (!open) setPendingKey(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingKey?.type === "rotate"
                ? `Reroll ${pendingKey.key.name}?`
                : `Revoke ${pendingKey?.key.name ?? "this key"}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingKey?.type === "rotate"
                ? "A new key is generated and shown once. The current key stops working immediately."
                : "Anything still using this key will start receiving 401s."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionBusy}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              size="sm"
              disabled={actionBusy}
              onClick={() => void runKeyAction()}
            >
              {actionBusy && <Spinner data-icon="inline-start" />}
              {actionBusy
                ? "working…"
                : pendingKey?.type === "rotate"
                  ? "Reroll key"
                  : "Revoke key"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={editKey !== null}
        onOpenChange={(open) => {
          if (!open) setEditKey(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit permissions</DialogTitle>
            <DialogDescription>
              Choose what <span className="text-mist">{editKey?.name ?? "this key"}</span> is
              allowed to do. At least one scope is required.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field orientation="horizontal">
              <Checkbox
                id="edit-ingest"
                checked={editIngest}
                onCheckedChange={(checked) => setEditIngest(checked === true)}
              />
              <FieldLabel
                htmlFor="edit-ingest"
                className="normal-case tracking-normal text-xs text-mist-dim"
              >
                ingest — write events
              </FieldLabel>
            </Field>
            <Field orientation="horizontal">
              <Checkbox
                id="edit-query"
                checked={editQuery}
                onCheckedChange={(checked) => setEditQuery(checked === true)}
              />
              <FieldLabel
                htmlFor="edit-query"
                className="normal-case tracking-normal text-xs text-mist-dim"
              >
                query — read events
              </FieldLabel>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              disabled={actionBusy}
              onClick={() => setEditKey(null)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={actionBusy || (!editIngest && !editQuery)}
              onClick={() => void saveKeyScopes()}
            >
              {actionBusy && <Spinner data-icon="inline-start" />}
              Save permissions
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------- clear logs ----------

type ClearRange = "1h" | "6h" | "24h" | "7d" | "30d" | "all" | "custom";

const CLEAR_RANGE_MS: Record<Exclude<ClearRange, "all" | "custom">, number> = {
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
  "30d": 30 * 24 * 60 * 60_000,
};

function toLocalInput(ts: number): string {
  const date = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

function ClearLogsCard({
  projectId,
  projectName,
  canClear,
}: {
  projectId: string;
  projectName: string;
  canClear: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<ClearRange>("24h");
  const [customFrom, setCustomFrom] = useState(() => toLocalInput(Date.now() - CLEAR_RANGE_MS["24h"]));
  const [customTo, setCustomTo] = useState(() => toLocalInput(Date.now()));
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!canClear) return null;

  const resolved = (): { from: number; to: number } | undefined => {
    if (range === "all") return undefined;
    const to = range === "custom" ? Date.parse(customTo) : Date.now();
    const from = range === "custom" ? Date.parse(customFrom) : to - CLEAR_RANGE_MS[range];
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return undefined;
    return { from, to };
  };

  const bounds = resolved();
  const summary =
    range === "all"
      ? "every stored event in this project"
      : bounds
        ? `${new Date(bounds.from).toLocaleString()} → ${new Date(bounds.to).toLocaleString()}`
        : "pick a valid start and end";

  const clear = async (): Promise<void> => {
    if (confirm !== projectName) return;
    if (range !== "all" && !bounds) {
      setError("Choose a valid start and end.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await clearProjectLogs(projectId, bounds);
      toast.success(`Deleted ${result.deleted.toLocaleString()} events`);
      setOpen(false);
      setConfirm("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Clear logs</CardTitle>
        <CardDescription>
          Delete stored events from this project. Keys, monitors, and alert history stay.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <AlertDialog
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) {
              setConfirm("");
              setError(null);
            }
          }}
        >
          <AlertDialogTrigger asChild>
            <Button variant="destructive" size="sm">
              <Trash2Icon data-icon="inline-start" />
              clear project logs
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Clear logs in {projectName}?</AlertDialogTitle>
              <AlertDialogDescription>
                This deletes <span className="text-mist">{summary}</span>. It cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>

            <Field>
              <FieldLabel htmlFor="clear-range">range</FieldLabel>
              <Select value={range} onValueChange={(value) => setRange(value as ClearRange)}>
                <SelectTrigger id="clear-range" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>Range</SelectLabel>
                    <SelectItem value="1h">last hour</SelectItem>
                    <SelectItem value="6h">last 6 hours</SelectItem>
                    <SelectItem value="24h">last 24 hours</SelectItem>
                    <SelectItem value="7d">last 7 days</SelectItem>
                    <SelectItem value="30d">last 30 days</SelectItem>
                    <SelectItem value="all">all time</SelectItem>
                    <SelectItem value="custom">custom range</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>

            {range === "custom" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="clear-from">from</FieldLabel>
                  <Input
                    id="clear-from"
                    type="datetime-local"
                    value={customFrom}
                    onChange={(e) => setCustomFrom(e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="clear-to">to</FieldLabel>
                  <Input
                    id="clear-to"
                    type="datetime-local"
                    value={customTo}
                    onChange={(e) => setCustomTo(e.target.value)}
                  />
                </Field>
              </div>
            )}

            <Field>
              <FieldLabel htmlFor="clear-confirm">type {projectName} to confirm</FieldLabel>
              <Input
                id="clear-confirm"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder={projectName}
                autoComplete="off"
              />
            </Field>

            <ErrorAlert error={error} />

            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={busy || confirm !== projectName || (range !== "all" && !bounds)}
                onClick={() => void clear()}
              >
                {busy && <Spinner data-icon="inline-start" />}
                {busy ? "clearing…" : "Clear logs"}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

function UsersPanel() {
  const { user } = useApp();
  const [users, setUsers] = useState<AppUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("member");
  const [password, setPassword] = useState("");
  const [createdPassword, setCreatedPassword] = useState<{ email: string; password: string } | null>(
    null
  );
  const [pendingUser, setPendingUser] = useState<{
    type: "delete" | "reset" | "disable";
    user: AppUser;
  } | null>(null);
  const [roleTarget, setRoleTarget] = useState<AppUser | null>(null);
  const [roleValue, setRoleValue] = useState("member");
  const [actionBusy, setActionBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setUsers((await fetchUsers()).users);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async (): Promise<void> => {
    if (!email.trim()) return;
    if (password) {
      const problem = passwordProblem(password);
      if (problem) {
        setError(problem);
        return;
      }
    }
    try {
      const result = await createUser({
        email: email.trim(),
        name: name.trim(),
        role,
        ...(password ? { password } : {}),
      });
      if (result.password) setCreatedPassword({ email: result.user.email, password: result.password });
      setEmail("");
      setName("");
      setPassword("");
      await load();
      toast.success("User created");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const changeRole = async (target: AppUser, nextRole: string): Promise<boolean> => {
    try {
      await updateUser(target.id, { role: nextRole });
      await load();
      toast.success("Role updated");
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  };

  const saveRole = async (): Promise<void> => {
    if (!roleTarget) return;
    if (await changeRole(roleTarget, roleValue)) setRoleTarget(null);
  };

  const remove = async (id: string): Promise<void> => {
    setActionBusy(true);
    try {
      await deleteUser(id);
      await load();
      setPendingUser(null);
      toast.success("User deleted");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPendingUser(null);
    } finally {
      setActionBusy(false);
    }
  };

  const resetPassword = async (target: AppUser): Promise<void> => {
    setActionBusy(true);
    try {
      const result = await resetUserPassword(target.id);
      setCreatedPassword({ email: target.email, password: result.password });
      setPendingUser(null);
      toast.success("Password reset");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPendingUser(null);
    } finally {
      setActionBusy(false);
    }
  };

  const setDisabled = async (target: AppUser, disabled: boolean): Promise<void> => {
    setActionBusy(true);
    try {
      await updateUser(target.id, { disabled });
      await load();
      setPendingUser(null);
      toast.success(disabled ? "User disabled" : "User enabled");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPendingUser(null);
    } finally {
      setActionBusy(false);
    }
  };

  return (
    <div className="mt-5 flex flex-col gap-3">
      <ErrorAlert error={error} />

      {createdPassword && (
        <Alert variant="gold">
          <KeyRoundIcon />
          <AlertTitle>Password for {createdPassword.email} — copy it now</AlertTitle>
          <AlertDescription>
            <div className="mt-2 flex items-center gap-2">
              <code className="rounded-[3px] bg-ink-900 px-2 py-1 text-mist">
                {createdPassword.password}
              </code>
              <CopyButton value={createdPassword.password} />
              <Button variant="chip" size="xs" onClick={() => setCreatedPassword(null)}>
                dismiss
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Users</CardTitle>
          <CardDescription>Administrators can create accounts and assign roles.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>user</TableHead>
                <TableHead>role</TableHead>
                <TableHead>status</TableHead>
                <TableHead className="text-right">actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => (
                <TableRow key={u.id}>
                  <TableCell>
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-mist">{u.email}</span>
                      <span className="text-[10px] text-mist-faint">{u.name || "—"}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={u.role === "admin" ? "default" : "outline"}
                      className="text-[10px] normal-case tracking-normal"
                    >
                      {u.role}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {u.disabled ? (
                      <Badge
                        variant="destructive"
                        className="text-[10px] normal-case tracking-normal"
                      >
                        disabled
                      </Badge>
                    ) : (
                      <Badge
                        variant="ghost"
                        className="text-[10px] normal-case tracking-normal"
                      >
                        active
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          disabled={u.id === user.id}
                          aria-label={`Actions for ${u.email}`}
                          title={
                            u.id === user.id
                              ? "Use the Account tab to change your own account"
                              : undefined
                          }
                        >
                          <MoreHorizontalIcon />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuLabel>User actions</DropdownMenuLabel>
                        <DropdownMenuGroup>
                          <DropdownMenuItem
                            disabled={u.role === "admin"}
                            onSelect={() => {
                              setRoleTarget(u);
                              setRoleValue(u.role === "viewer" ? "viewer" : "member");
                            }}
                          >
                            <UserCogIcon />
                            Change role
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={u.id === user.id}
                            onSelect={() => setPendingUser({ type: "reset", user: u })}
                          >
                            <KeyRoundIcon />
                            Reset password
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={u.role === "admin"}
                            onSelect={() => {
                              if (u.disabled) void setDisabled(u, false);
                              else setPendingUser({ type: "disable", user: u });
                            }}
                          >
                            {u.disabled ? <CircleCheckIcon /> : <BanIcon />}
                            {u.disabled ? "Enable user" : "Disable user"}
                          </DropdownMenuItem>
                        </DropdownMenuGroup>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          disabled={u.role === "admin"}
                          onSelect={() => setPendingUser({ type: "delete", user: u })}
                        >
                          <Trash2Icon />
                          Delete user
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
              {users.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="py-4 text-center text-mist-faint">
                    No users loaded.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>

          <form
            className="grid gap-3 border-t border-white/[0.06] pt-4 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              void add();
            }}
          >
            <Field>
              <FieldLabel htmlFor="user-email">email</FieldLabel>
              <Input
                id="user-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="user-name">name</FieldLabel>
              <Input
                id="user-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Jane Doe"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="user-role">role</FieldLabel>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger id="user-role" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>Role</SelectLabel>
                    <SelectItem value="member">member — logs, monitors, keys</SelectItem>
                    <SelectItem value="viewer">viewer — read only</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="user-password">password (blank = generated)</FieldLabel>
              <PasswordInput
                id="user-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Leave blank to generate"
              />
              {password && <PasswordRequirements value={password} />}
            </Field>
            <div className="sm:col-span-2">
              <Button
                type="submit"
                size="sm"
                disabled={!email.trim() || (password.length > 0 && passwordProblem(password) !== null)}
              >
                <UserPlusIcon data-icon="inline-start" />
                add user
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <AlertDialog
        open={pendingUser !== null}
        onOpenChange={(open) => {
          if (!open) setPendingUser(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingUser?.type === "reset"
                ? `Reset password for ${pendingUser.user.email}?`
                : pendingUser?.type === "disable"
                  ? `Disable ${pendingUser.user.email}?`
                  : `Delete ${pendingUser?.user.email ?? "this user"}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingUser?.type === "reset"
                ? "A new password is generated and shown once. Their current password and all sessions stop working."
                : pendingUser?.type === "disable"
                  ? "They are signed out immediately and cannot sign in until you enable them again."
                  : "The account and its sessions are removed immediately. This cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionBusy}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              size="sm"
              disabled={actionBusy}
              onClick={() => {
                if (!pendingUser) return;
                if (pendingUser.type === "reset") void resetPassword(pendingUser.user);
                else if (pendingUser.type === "disable") void setDisabled(pendingUser.user, true);
                else void remove(pendingUser.user.id);
              }}
            >
              {actionBusy && <Spinner data-icon="inline-start" />}
              {pendingUser?.type === "reset"
                ? "Reset password"
                : pendingUser?.type === "disable"
                  ? "Disable user"
                  : "Delete user"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={roleTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRoleTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change role</DialogTitle>
            <DialogDescription>
              Choose the role for {roleTarget?.email ?? "this user"}.
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="change-role">role</FieldLabel>
            <Select value={roleValue} onValueChange={setRoleValue}>
              <SelectTrigger id="change-role" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>Role</SelectLabel>
                  <SelectItem value="member">member — logs, monitors, keys</SelectItem>
                  <SelectItem value="viewer">viewer — read only</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setRoleTarget(null)}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void saveRole()}>
              Save role
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------- account ----------

function AccountPanel() {
  const { user } = useApp();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const nextProblem = passwordProblem(next);

  const submit = async (): Promise<void> => {
    if (next !== confirm) {
      setError("new passwords don't match");
      return;
    }
    const problem = passwordProblem(next);
    if (problem) {
      setError(problem);
      return;
    }
    try {
      await changePassword(current, next);
      setError(null);
      setCurrent("");
      setNext("");
      setConfirm("");
      toast.success("Password updated");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="mt-5 flex flex-col gap-3">
      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
          <CardDescription>
            {user.email} · <span className="text-gold">{user.role}</span>
            {user.name ? ` · ${user.name}` : ""}
          </CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Change password</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-3 sm:grid-cols-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Field>
              <FieldLabel htmlFor="current-password">current</FieldLabel>
              <PasswordInput
                id="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="new-password">new</FieldLabel>
              <PasswordInput
                id="new-password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="confirm-password">confirm</FieldLabel>
              <PasswordInput
                id="confirm-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
              {confirm && next !== confirm && (
                <p className="font-mono text-[10px] text-coral">passwords don&apos;t match</p>
              )}
            </Field>
            <div className="sm:col-span-3">
              <PasswordRequirements value={next} />
            </div>
            <div className="sm:col-span-3">
              <ErrorAlert error={error} />
            </div>
            <div className="sm:col-span-3">
              <Button
                type="submit"
                size="sm"
                disabled={!current || nextProblem !== null || next !== confirm}
              >
                update password
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
