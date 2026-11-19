import { useCallback, useEffect, useState } from "react";
import { UserPlusIcon } from "lucide-react";
import { toast } from "sonner";
import {
  addProjectMember,
  fetchProjectMembers,
  fetchUsers,
  removeProjectMember,
  updateProjectMember,
} from "../../api";
import type { AppUser, ProjectMember } from "../../types";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export default function MembersCard({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [allUsers, setAllUsers] = useState<AppUser[]>([]);
  const [memberToAdd, setMemberToAdd] = useState("");
  const [error, setError] = useState<string | null>(null);

  const loadMembers = useCallback(async () => {
    try {
      const [m, u] = await Promise.all([fetchProjectMembers(projectId), fetchUsers()]);
      setMembers(m.members);
      setAllUsers(u.users);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [projectId]);

  useEffect(() => {
    setMemberToAdd("");
    void loadMembers();
  }, [loadMembers]);

  const eligibleUsers = allUsers.filter((u) => u.role !== "admin");
  const candidates = eligibleUsers.filter((u) => !members.some((m) => m.userId === u.id));
  const memberEmptyMessage =
    eligibleUsers.length === 0
      ? "No member accounts yet. Create one under Workspace → Users."
      : "No members assigned yet.";

  const addMember = async (): Promise<void> => {
    if (!memberToAdd) return;
    try {
      await addProjectMember(projectId, memberToAdd);
      setMemberToAdd("");
      await loadMembers();
      toast.success("Member added");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const removeMember = async (userId: string): Promise<void> => {
    try {
      await removeProjectMember(projectId, userId);
      await loadMembers();
      toast.success("Member removed");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const setMemberClearLogs = async (
    member: ProjectMember,
    canClearLogs: boolean,
  ): Promise<void> => {
    try {
      await updateProjectMember(projectId, member.userId, { canClearLogs });
      await loadMembers();
      toast.success(
        canClearLogs
          ? `Allowed ${member.email} to clear logs`
          : `Revoked clear logs from ${member.email}`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <ErrorAlert error={error} />

      <Card>
        <CardHeader>
          <CardTitle>Members — {projectName}</CardTitle>
          <CardDescription>
            Admins see every project. Members and viewers see only the projects assigned here.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
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
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          className="inline-flex rounded-full focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gold/40"
                          tabIndex={m.role === "viewer" ? 0 : -1}
                        >
                          <Switch
                            checked={m.canClearLogs}
                            onCheckedChange={(checked) => void setMemberClearLogs(m, checked)}
                            disabled={m.role === "viewer"}
                            aria-label={`Allow ${m.email} to clear logs`}
                          />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        {m.role === "viewer"
                          ? "Viewers cannot be granted clear logs"
                          : m.canClearLogs
                            ? "Revoke clear logs"
                            : "Allow clear logs"}
                      </TooltipContent>
                    </Tooltip>
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

          {candidates.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <Select value={memberToAdd} onValueChange={setMemberToAdd}>
                <SelectTrigger className="w-64" aria-label="User to add">
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
                disabled={!memberToAdd}
                onClick={() => void addMember()}
              >
                <UserPlusIcon data-icon="inline-start" />
                add member
              </Button>
            </div>
          ) : (
            members.length > 0 && (
              <p className="font-mono text-[10px] text-mist-faint">
                Every member account is already assigned to this project.
              </p>
            )
          )}
        </CardContent>
      </Card>
    </div>
  );
}
