import { useState } from "react";
import { KeyRoundIcon } from "lucide-react";
import { toast } from "sonner";
import { changePassword } from "../../api";
import { useApp } from "../../app-context";
import { passwordProblem } from "../../lib/password";
import type { UserRole } from "../../types";
import ErrorAlert from "../ErrorAlert";
import PasswordInput from "../PasswordInput";
import PasswordRequirements from "../PasswordRequirements";
import SettingsRow from "../SettingsRow";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";

const ROLE_HINTS: Record<UserRole, string> = {
  admin: "Every project, users, backups, and notification channels.",
  member: "Logs, monitors, and keys in the projects you're assigned.",
  viewer: "Read-only access to the projects you're assigned.",
};

export default function AccountPanel() {
  const { user } = useApp();
  const [passwordOpen, setPasswordOpen] = useState(false);

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>The signed-in user for this Kinglet instance.</CardDescription>
        </CardHeader>
        <CardContent>
          <SettingsRow label="email">
            <span className="break-all font-mono text-xs text-mist-dim">{user.email}</span>
          </SettingsRow>
          <SettingsRow label="name">
            <span className="font-mono text-xs text-mist-dim">{user.name || "—"}</span>
          </SettingsRow>
          <SettingsRow label="role" description={ROLE_HINTS[user.role]}>
            <Badge
              variant={user.role === "admin" ? "default" : "outline"}
              className="text-[10px] normal-case tracking-normal"
            >
              {user.role}
            </Badge>
          </SettingsRow>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Security</CardTitle>
        </CardHeader>
        <CardContent>
          <SettingsRow
            label="password"
            description="Changing it signs out your other sessions. You need the current one."
          >
            <Button variant="outline" size="sm" onClick={() => setPasswordOpen(true)}>
              <KeyRoundIcon data-icon="inline-start" />
              change password
            </Button>
          </SettingsRow>
        </CardContent>
      </Card>

      <Dialog open={passwordOpen} onOpenChange={setPasswordOpen}>
        <DialogContent className="sm:max-w-md">
          {passwordOpen && <PasswordForm onDone={() => setPasswordOpen(false)} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Mounted fresh each time the dialog opens, so nothing typed lingers. */
function PasswordForm({ onDone }: { onDone: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
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

    setSaving(true);

    try {
      await changePassword(current, next);
      toast.success("Password updated");
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>Change password</DialogTitle>
        <DialogDescription>Enter your current password, then the new one twice.</DialogDescription>
      </DialogHeader>
      <FieldGroup className="mt-4">
        <Field>
          <FieldLabel htmlFor="current-password">current</FieldLabel>
          <PasswordInput
            id="current-password"
            value={current}
            autoComplete="current-password"
            onChange={(e) => setCurrent(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="new-password">new</FieldLabel>
          <PasswordInput
            id="new-password"
            value={next}
            autoComplete="new-password"
            onChange={(e) => setNext(e.target.value)}
          />
          <PasswordRequirements value={next} />
        </Field>
        <Field>
          <FieldLabel htmlFor="confirm-password">confirm</FieldLabel>
          <PasswordInput
            id="confirm-password"
            value={confirm}
            autoComplete="new-password"
            onChange={(e) => setConfirm(e.target.value)}
          />
          {confirm && next !== confirm && (
            <p className="font-mono text-[10px] text-coral">passwords don&apos;t match</p>
          )}
        </Field>
        <ErrorAlert error={error} />
      </FieldGroup>
      <DialogFooter className="mt-4">
        <Button variant="outline" size="sm" type="button" onClick={onDone}>
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={saving || !current || nextProblem !== null || next !== confirm}
        >
          update password
        </Button>
      </DialogFooter>
    </form>
  );
}
