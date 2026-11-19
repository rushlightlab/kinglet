import { useCallback, useEffect, useState } from "react";
import {
  BarChart3Icon,
  KeyRoundIcon,
  MoreHorizontalIcon,
  PlusIcon,
  RotateCcwIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  createKey,
  deleteKey,
  fetchKeys,
  rotateKey,
  updateKeyScopes,
} from "../../api";
import { hasPermission, useApp } from "../../app-context";
import type { ApiKeyInfo } from "../../types";
import CopyButton from "../CopyButton";
import ErrorAlert from "../ErrorAlert";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export default function KeysCard({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const { permissions } = useApp();
  const navigate = useNavigate();
  const canWriteKeys = hasPermission(permissions, "keys.write");

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

  const load = useCallback(async () => {
    try {
      setKeys((await fetchKeys(projectId)).keys);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [projectId]);

  useEffect(() => {
    setCreatedKey(null);
    void load();
  }, [load]);

  const create = async (): Promise<void> => {
    const scopes = [scopeIngest ? "ingest" : null, scopeQuery ? "query" : null].filter(
      (s): s is string => s !== null
    );
    if (!name.trim() || scopes.length === 0) return;
    setBusy(true);
    try {
      const result = await createKey(projectId, { name: name.trim(), scopes });
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
      await updateKeyScopes(editKey.id, projectId, scopes);
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
        const rotated = await rotateKey(pendingKey.key.id, projectId);
        setCreatedKey(rotated.plaintext);
        toast.success("Key rerolled");
      } else {
        await deleteKey(pendingKey.key.id, projectId);
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

  return (
    <div className="flex flex-col gap-3">
      <ErrorAlert error={error} />

      <Card>
        <CardHeader>
          <CardTitle>API keys — {projectName}</CardTitle>
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
