import { useState } from "react";
import {
  BanIcon,
  CircleCheckIcon,
  KeyRoundIcon,
  MoreHorizontalIcon,
  Trash2Icon,
  UserCogIcon,
  UserPlusIcon,
} from "lucide-react";
import { toast } from "sonner";
import { createUser, deleteUser, fetchUsers, resetUserPassword, updateUser } from "../../api";
import type { PageQuery, UserPatch } from "../../api";
import { useApp } from "../../app-context";
import type { AppUser, UserRole } from "../../types";
import { passwordProblem } from "../../lib/password";
import CopyButton from "../CopyButton";
import ErrorAlert from "../ErrorAlert";
import SkeletonRows from "../SkeletonRows";
import TablePagination from "../TablePagination";
import TableSearch, { NoMatchesRow } from "../TableSearch";
import { fadeWhileLoading, useServerTable } from "../../server-table";
import type { TablePage } from "../../server-table";
import PasswordInput from "../PasswordInput";
import PasswordRequirements from "../PasswordRequirements";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

async function loadUserPage(page: PageQuery): Promise<TablePage<AppUser>> {
  const result = await fetchUsers(page);

  return { rows: result.users, total: result.total };
}

function isUserRole(value: string): value is UserRole {
  return value === "admin" || value === "member" || value === "viewer";
}

/** What a role change will do beyond the label, shown before saving. */
function roleChangeNote(from: UserRole, to: UserRole): string | null {
  if (from === to) return null;

  if (to === "admin") {
    return "Admins see every project and manage users, backups, and notification channels.";
  }

  if (to === "viewer" || from === "admin") {
    return "Demoting revokes every API and MCP key this user created.";
  }

  return null;
}

export default function UsersPanel() {
  const { user } = useApp();
  const userTable = useServerTable("users", loadUserPage);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("member");
  const [password, setPassword] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [createdPassword, setCreatedPassword] = useState<{
    email: string;
    password: string;
  } | null>(null);

  const [pendingUser, setPendingUser] = useState<{
    type: "delete" | "reset" | "disable";
    user: AppUser;
  } | null>(null);

  const [editTarget, setEditTarget] = useState<AppUser | null>(null);
  const [editName, setEditName] = useState("");
  const [editRole, setEditRole] = useState<UserRole>("member");
  const [editError, setEditError] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);

  const load = userTable.reload;

  const add = async (): Promise<void> => {
    if (!email.trim()) return;

    if (password) {
      const problem = passwordProblem(password);

      if (problem) {
        setFormError(problem);

        return;
      }
    }

    try {
      const newUser = {
        email: email.trim(),
        name: name.trim(),
        role,
      };

      const result = await createUser(password ? { ...newUser, password } : newUser);

      if (result.password)
        setCreatedPassword({ email: result.user.email, password: result.password });
      setEmail("");
      setName("");
      setPassword("");
      setFormError(null);
      setAddOpen(false);
      await load();
      toast.success("User created");
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    }
  };

  const openEdit = (target: AppUser): void => {
    setEditTarget(target);
    setEditName(target.name);
    setEditRole(target.role);
    setEditError(null);
  };

  // Sends only what changed. The server guards the last administrator and
  // revokes a demoted user's keys.
  const saveEdit = async (): Promise<void> => {
    if (!editTarget) return;
    const patch: UserPatch = {};

    if (editName.trim() !== editTarget.name) patch.name = editName.trim();

    if (editRole !== editTarget.role && editTarget.id !== user.id) patch.role = editRole;

    if (patch.name === undefined && patch.role === undefined) {
      setEditTarget(null);

      return;
    }

    setEditSaving(true);

    try {
      await updateUser(editTarget.id, patch);
      setEditTarget(null);
      await load();
      toast.success("User updated", { description: editTarget.email });
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err));
    } finally {
      setEditSaving(false);
    }
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
    <div className="flex flex-col gap-3">
      <ErrorAlert error={error ?? userTable.error} />

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
          <CardAction className="row-span-1 flex items-center gap-2 self-center">
            <TableSearch
              label="Search users"
              value={userTable.query}
              onChange={userTable.setQuery}
            />
            <Button size="sm" className="shrink-0" onClick={() => setAddOpen(true)}>
              <UserPlusIcon data-icon="inline-start" />
              add user
            </Button>
          </CardAction>
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
            <TableBody className={fadeWhileLoading(userTable)}>
              {userTable.rows.map((u) => (
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
                      <Badge variant="ghost" className="text-[10px] normal-case tracking-normal">
                        active
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {(() => {
                      const isSelf = u.id === user.id;

                      return (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              aria-label={`Actions for ${u.email}`}
                            >
                              <MoreHorizontalIcon />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuLabel>User actions</DropdownMenuLabel>
                            <DropdownMenuGroup>
                              <DropdownMenuItem onSelect={() => openEdit(u)}>
                                <UserCogIcon />
                                Edit user
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                disabled={isSelf}
                                onSelect={() => setPendingUser({ type: "reset", user: u })}
                              >
                                <KeyRoundIcon />
                                {isSelf ? "Reset password (use my account)" : "Reset password"}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                disabled={u.role === "admin"}
                                onSelect={() => {
                                  if (u.disabled) void setDisabled(u, false);
                                  else setPendingUser({ type: "disable", user: u });
                                }}
                              >
                                {u.disabled ? <CircleCheckIcon /> : <BanIcon />}
                                {u.disabled
                                  ? "Enable user"
                                  : u.role === "admin"
                                    ? "Disable user (demote first)"
                                    : "Disable user"}
                              </DropdownMenuItem>
                            </DropdownMenuGroup>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              disabled={u.role === "admin"}
                              onSelect={() => setPendingUser({ type: "delete", user: u })}
                            >
                              <Trash2Icon />
                              {u.role === "admin" ? "Delete user (demote first)" : "Delete user"}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      );
                    })()}
                  </TableCell>
                </TableRow>
              ))}
              {!userTable.loaded && <SkeletonRows columns={4} label="Loading users…" />}
              {userTable.loaded && userTable.total === 0 && userTable.activeQuery !== "" && (
                <NoMatchesRow
                  columns={4}
                  query={userTable.activeQuery}
                  noun="users"
                  onClear={() => userTable.setQuery("")}
                />
              )}
              {userTable.loaded && userTable.total === 0 && userTable.activeQuery === "" && (
                <TableRow>
                  <TableCell colSpan={4} className="py-4 text-center text-mist-faint">
                    No users loaded.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
        <TablePagination table={userTable} noun="users" className="-mb-4" />
      </Card>

      <Dialog
        open={addOpen}
        onOpenChange={(open) => {
          setAddOpen(open);

          if (!open) setFormError(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add user</DialogTitle>
            <DialogDescription>
              Members can use logs, monitors, and keys in the projects you assign them; viewers can
              only read. Leave the password blank to generate one that is shown once.
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-3 sm:grid-cols-2"
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
            {formError && (
              <p className="font-mono text-[11px] text-coral sm:col-span-2" role="alert">
                {formError}
              </p>
            )}
            <DialogFooter className="sm:col-span-2">
              <Button variant="outline" size="sm" type="button" onClick={() => setAddOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={
                  !email.trim() || (password.length > 0 && passwordProblem(password) !== null)
                }
              >
                <UserPlusIcon data-icon="inline-start" />
                Create user
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

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
        open={editTarget !== null}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void saveEdit();
            }}
          >
            <DialogHeader>
              <DialogTitle>Edit user</DialogTitle>
              <DialogDescription>{editTarget?.email ?? "this user"}</DialogDescription>
            </DialogHeader>
            <FieldGroup className="mt-4">
              <Field>
                <FieldLabel htmlFor="edit-user-name">name</FieldLabel>
                <Input
                  id="edit-user-name"
                  value={editName}
                  maxLength={80}
                  onChange={(event) => setEditName(event.target.value)}
                  placeholder="Jane Doe"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="edit-user-role">role</FieldLabel>
                <Select
                  value={editRole}
                  disabled={editTarget?.id === user.id}
                  onValueChange={(value) => {
                    if (isUserRole(value)) setEditRole(value);
                  }}
                >
                  <SelectTrigger id="edit-user-role" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectLabel>Role</SelectLabel>
                      <SelectItem value="admin">admin — every project, users, backups</SelectItem>
                      <SelectItem value="member">member — logs, monitors, keys</SelectItem>
                      <SelectItem value="viewer">viewer — read only</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {editTarget?.id === user.id ? (
                  <FieldDescription>You can&apos;t change your own role.</FieldDescription>
                ) : editTarget && roleChangeNote(editTarget.role, editRole) ? (
                  <FieldDescription className="text-gold/80">
                    {roleChangeNote(editTarget.role, editRole)}
                  </FieldDescription>
                ) : null}
              </Field>
              {editError && (
                <p className="font-mono text-[11px] text-coral" role="alert">
                  {editError}
                </p>
              )}
            </FieldGroup>
            <DialogFooter className="mt-4">
              <Button variant="outline" size="sm" type="button" onClick={() => setEditTarget(null)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={editSaving}>
                {editSaving && <Spinner data-icon="inline-start" />}
                Save changes
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
