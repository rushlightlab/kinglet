import { useState } from "react";
import { toast } from "sonner";
import { changePassword } from "../../api";
import { useApp } from "../../app-context";
import { passwordProblem } from "../../lib/password";
import ErrorAlert from "../ErrorAlert";
import PasswordInput from "../PasswordInput";
import PasswordRequirements from "../PasswordRequirements";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";

export default function AccountPanel() {
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
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
          <CardDescription>The signed-in user for this Kinglet instance.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid items-start gap-x-6 gap-y-3 sm:grid-cols-[5rem_1fr]">
            <dt className="font-mono text-[10px] text-mist-faint">email</dt>
            <dd className="break-all font-mono text-xs text-mist">{user.email}</dd>

            <dt className="font-mono text-[10px] text-mist-faint">role</dt>
            <dd>
              <Badge
                variant={user.role === "admin" ? "default" : "outline"}
                className="text-[10px] normal-case tracking-normal"
              >
                {user.role}
              </Badge>
            </dd>

            <dt className="font-mono text-[10px] text-mist-faint">name</dt>
            <dd className="font-mono text-xs text-mist">{user.name || "—"}</dd>
          </dl>
        </CardContent>
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
                className="shadow-none hover:translate-y-0 hover:shadow-none"
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
