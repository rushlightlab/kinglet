import { useCallback, useEffect, useState } from "react";
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
import { useApp } from "../../app-context";
import type { AppUser } from "../../types";
import { passwordProblem } from "../../lib/password";
import CopyButton from "../CopyButton";
import ErrorAlert from "../ErrorAlert";
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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

export default function UsersPanel() {
  const { user } = useApp();
  const [users, setUsers] = useState<AppUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("member");
  const [password, setPassword] = useState("");

  const [createdPassword, setCreatedPassword] = useState<{
    email: string;
    password: string;
  } | null>(null);

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

      if (result.password)
        setCreatedPassword({ email: result.user.email, password: result.password });
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
    <div className="flex flex-col gap-3">
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
                      <Badge variant="ghost" className="text-[10px] normal-case tracking-normal">
                        active
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {(() => {
                      const isSelf = u.id === user.id;

                      const trigger = (
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            disabled={isSelf}
                            aria-label={`Actions for ${u.email}`}
                          >
                            <MoreHorizontalIcon />
                          </Button>
                        </DropdownMenuTrigger>
                      );

                      return (
                        <DropdownMenu>
                          {isSelf ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span
                                  tabIndex={0}
                                  className="inline-flex rounded-[4px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gold/40"
                                >
                                  {trigger}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>
                                Use Account settings to change your own account
                              </TooltipContent>
                            </Tooltip>
                          ) : (
                            trigger
                          )}
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
                                disabled={isSelf}
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
                      );
                    })()}
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
                className="shadow-none hover:translate-y-0 hover:shadow-none"
                disabled={
                  !email.trim() || (password.length > 0 && passwordProblem(password) !== null)
                }
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
