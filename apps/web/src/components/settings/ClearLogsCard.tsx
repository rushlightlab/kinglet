import { useState } from "react";
import { Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { clearProjectLogs } from "../../api";
import ErrorAlert from "../ErrorAlert";
import {
  AlertDialog,
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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

export default function ClearLogsCard({
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
  const [customFrom, setCustomFrom] = useState(() =>
    toLocalInput(Date.now() - CLEAR_RANGE_MS["24h"])
  );
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
        ? `${new Date(bounds.from).toLocaleString()} to ${new Date(bounds.to).toLocaleString()}`
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
