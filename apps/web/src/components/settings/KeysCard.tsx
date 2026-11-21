import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  BarChart3Icon,
  BotIcon,
  KeyRoundIcon,
  MoreHorizontalIcon,
  PlusIcon,
  RotateCcwIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { createKey, deleteKey, fetchKeys, rotateKey, updateKeyScopes } from "../../api";
import { hasPermission, useApp } from "../../app-context";
import type { ApiKeyInfo, KeyType } from "../../types";
import CopyButton from "../CopyButton";
import ErrorAlert from "../ErrorAlert";
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
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

const MCP_SCOPES = ["logs.read", "monitors.read", "monitors.write"] as const;

function keyTypeOf(key: ApiKeyInfo): KeyType {
  return key.keyType ?? "api";
}

/** Client config for the one-time MCP setup snippet. */
function mcpConfigSnippet(plaintext: string): string {
  const config = {
    mcpServers: {
      kinglet: {
        command: "npx",
        // Keep the setup snippet on the reviewed release instead of the
        // mutable latest dist-tag.
        args: ["-y", "@kinglet/mcp@0.4.0"],
        env: {
          KINGLET_URL: window.location.origin,
          KINGLET_MCP_KEY: plaintext,
        },
      },
    },
  };

  return JSON.stringify(config, null, 2);
}

interface CreatedSecret {
  plaintext: string;
  keyType: KeyType;
}

export default function KeysCard({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const { permissions, user } = useApp();
  const navigate = useNavigate();
  const canWriteKeys = hasPermission(permissions, "keys.write");

  const canManageKey = (key: ApiKeyInfo): boolean =>
    canWriteKeys && (user.role === "admin" || key.createdBy === user.id);

  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [appName, setAppName] = useState("");
  const [scopeIngest, setScopeIngest] = useState(true);
  const [scopeQuery, setScopeQuery] = useState(true);
  const [creatingApp, setCreatingApp] = useState(false);

  const [mcpOpen, setMcpOpen] = useState(false);
  const [mcpName, setMcpName] = useState("");
  const [mcpLogs, setMcpLogs] = useState(true);
  const [mcpMonitorsRead, setMcpMonitorsRead] = useState(true);
  const [mcpMonitorsWrite, setMcpMonitorsWrite] = useState(false);
  const [creatingMcp, setCreatingMcp] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);

  const [createdSecret, setCreatedSecret] = useState<CreatedSecret | null>(null);

  const [pendingKey, setPendingKey] = useState<{
    type: "revoke" | "rotate";
    key: ApiKeyInfo;
  } | null>(null);

  const [editKey, setEditKey] = useState<ApiKeyInfo | null>(null);
  const [editScopes, setEditScopes] = useState<string[]>([]);
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
    setCreatedSecret(null);
    setMcpOpen(false);
    setEditKey(null);
    void load();
  }, [load]);

  const createApplicationKey = async (): Promise<void> => {
    const scopes: string[] = [];

    if (scopeIngest) scopes.push("ingest");

    if (scopeQuery) scopes.push("query");

    if (!appName.trim() || scopes.length === 0) return;
    setCreatingApp(true);

    try {
      const result = await createKey(projectId, { name: appName.trim(), scopes });

      setCreatedSecret({ plaintext: result.plaintext, keyType: "api" });
      setAppName("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingApp(false);
    }
  };

  const createMcpKey = async (): Promise<void> => {
    const scopes: string[] = [];

    if (mcpLogs) scopes.push("logs.read");

    if (mcpMonitorsRead || mcpMonitorsWrite) scopes.push("monitors.read");

    if (mcpMonitorsWrite) scopes.push("monitors.write");

    if (!mcpName.trim() || scopes.length === 0) return;
    setCreatingMcp(true);
    setMcpError(null);

    try {
      const result = await createKey(projectId, {
        name: mcpName.trim(),
        scopes,
        keyType: "mcp",
      });

      setMcpOpen(false);
      setMcpName("");
      setMcpLogs(true);
      setMcpMonitorsRead(true);
      setMcpMonitorsWrite(false);
      setCreatedSecret({ plaintext: result.plaintext, keyType: "mcp" });
      await load();
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingMcp(false);
    }
  };

  const openKeyScopes = (key: ApiKeyInfo): void => {
    setEditKey(key);
    setEditScopes(key.scopes);
  };

  const toggleEditScope = (scope: string, checked: boolean): void => {
    setEditScopes((prev) => {
      if (checked) {
        const next = prev.includes(scope) ? prev : [...prev, scope];

        // Managing monitors requires reading them.
        if (scope === "monitors.write" && !next.includes("monitors.read")) {
          next.push("monitors.read");
        }

        return next;
      }

      const next = prev.filter((item) => item !== scope);

      if (scope === "monitors.read") {
        return next.filter((item) => item !== "monitors.write");
      }

      return next;
    });
  };

  const saveKeyScopes = async (): Promise<void> => {
    if (!editKey || editScopes.length === 0) return;
    setActionBusy(true);

    try {
      await updateKeyScopes(editKey.id, projectId, editScopes);
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

        setCreatedSecret({
          plaintext: rotated.plaintext,
          keyType: keyTypeOf(pendingKey.key),
        });
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

  const applicationKeys = keys.filter((key) => keyTypeOf(key) === "api");
  const mcpKeys = keys.filter((key) => keyTypeOf(key) === "mcp");

  const renderKeyTable = (rows: ApiKeyInfo[], emptyText: string): ReactNode => (
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
        {rows.map((key) => {
          const keyType = keyTypeOf(key);

          return (
            <TableRow key={key.id}>
              <TableCell>
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-mist">{key.name}</span>
                  <Badge variant={keyType === "mcp" ? "secondary" : "outline"}>
                    {keyType === "mcp" ? "mcp" : "api"}
                  </Badge>
                </div>
              </TableCell>
              <TableCell>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex items-center rounded-[3px] border border-white/[0.08] bg-white/[0.025] px-1.5 py-0.5 font-mono text-[10px] text-mist-dim">
                      {key.prefix}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="font-mono">key:{key.id}</TooltipContent>
                </Tooltip>
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {key.scopes.map((scope) => (
                    <Badge key={scope}>{scope}</Badge>
                  ))}
                </div>
              </TableCell>
              <TableCell className="hidden text-[10px] text-mist-faint md:table-cell">
                {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleDateString() : "No activity"}
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
                    <Button variant="ghost" size="icon-xs" aria-label={`Actions for ${key.name}`}>
                      <MoreHorizontalIcon />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuLabel>Key actions</DropdownMenuLabel>
                    <DropdownMenuGroup>
                      {keyType === "api" && (
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
                      )}
                      <DropdownMenuItem
                        disabled={!canManageKey(key)}
                        onSelect={() => openKeyScopes(key)}
                      >
                        <SlidersHorizontalIcon />
                        Edit permissions
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={!canManageKey(key)}
                        onSelect={() => setPendingKey({ type: "rotate", key })}
                      >
                        <RotateCcwIcon />
                        Reroll key
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={!canManageKey(key)}
                      onSelect={() => setPendingKey({ type: "revoke", key })}
                    >
                      <Trash2Icon />
                      Revoke key
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
          );
        })}
        {rows.length === 0 && (
          <TableRow>
            <TableCell colSpan={6} className="py-4 text-center text-mist-faint">
              {emptyText}
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );

  return (
    <div className="flex flex-col gap-3">
      <ErrorAlert error={error} />

      <Card>
        <CardHeader>
          <CardTitle>Application keys — {projectName}</CardTitle>
          <CardDescription>
            Keys are machine credentials: <span className="text-gold">ingest</span> writes logs,{" "}
            <span className="text-gold">query</span> reads them. The full key is shown once.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {createdSecret?.keyType === "api" && (
            <Alert variant="gold">
              <KeyRoundIcon />
              <AlertTitle>Copy this key now — it won&apos;t be shown again</AlertTitle>
              <AlertDescription>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <code className="break-all rounded-[3px] bg-ink-900 px-2 py-1 text-mist">
                    {createdSecret.plaintext}
                  </code>
                  <CopyButton value={createdSecret.plaintext} />
                </div>
              </AlertDescription>
            </Alert>
          )}

          {renderKeyTable(applicationKeys, "No application keys for this project yet.")}

          {canWriteKeys && (
            <form
              className="flex flex-wrap items-end gap-3 border-t border-white/[0.06] pt-4"
              onSubmit={(event) => {
                event.preventDefault();
                void createApplicationKey();
              }}
            >
              <Field className="min-w-40 flex-1">
                <FieldLabel htmlFor="key-name">key name</FieldLabel>
                <Input
                  id="key-name"
                  value={appName}
                  onChange={(event) => setAppName(event.target.value)}
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
                className="shadow-none hover:translate-y-0 hover:shadow-none"
                disabled={creatingApp || !appName.trim() || (!scopeIngest && !scopeQuery)}
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
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <BotIcon className="size-4 text-gold/80" />
                <CardTitle>MCP keys — {projectName}</CardTitle>
              </div>
              <CardDescription>
                AI clients use a project-scoped <span className="text-gold">km_</span> key to search
                logs and manage monitors. It never inherits a human role.
              </CardDescription>
            </div>
            {canWriteKeys && (
              <Button
                size="sm"
                onClick={() => {
                  setMcpError(null);
                  setMcpOpen(true);
                }}
              >
                <PlusIcon data-icon="inline-start" />
                new MCP key
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {renderKeyTable(
            mcpKeys,
            "No MCP keys yet. Create one for Claude Desktop, Cursor, or Codex.",
          )}

          <p className="font-mono text-[10px] leading-relaxed text-mist-faint">
            Default scopes are <span className="text-mist-dim">logs.read</span> and{" "}
            <span className="text-mist-dim">monitors.read</span>. Grant{" "}
            <span className="text-mist-dim">monitors.write</span> only when the client should change
            monitors.
          </p>
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
        open={mcpOpen}
        onOpenChange={(open) => {
          if (!open) setMcpOpen(false);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void createMcpKey();
            }}
          >
            <DialogHeader>
              <DialogTitle>New MCP key</DialogTitle>
              <DialogDescription>
                Scopes are limited to this project. The secret is shown once, so copy it into your
                MCP client immediately.
              </DialogDescription>
            </DialogHeader>

            <FieldGroup className="mt-4">
              <Field>
                <FieldLabel htmlFor="mcp-name">name</FieldLabel>
                <Input
                  id="mcp-name"
                  value={mcpName}
                  onChange={(event) => setMcpName(event.target.value)}
                  placeholder="Claude Desktop"
                />
              </Field>

              <div className="flex flex-col gap-2 rounded-[5px] border border-white/[0.06] p-3">
                <label className="flex items-center justify-between gap-3" htmlFor="mcp-logs">
                  <span className="flex flex-col gap-0.5">
                    <span className="font-mono text-xs text-mist">read logs</span>
                    <span className="font-mono text-[10px] text-mist-faint">
                      Search events, histogram, and services.
                    </span>
                  </span>
                  <Switch
                    id="mcp-logs"
                    checked={mcpLogs}
                    onCheckedChange={setMcpLogs}
                    aria-label="Read logs"
                  />
                </label>

                <label
                  className="flex items-center justify-between gap-3"
                  htmlFor="mcp-monitors-read"
                >
                  <span className="flex flex-col gap-0.5">
                    <span className="font-mono text-xs text-mist">read monitors</span>
                    <span className="font-mono text-[10px] text-mist-faint">
                      List monitors, alerts, and channel health. No URLs.
                    </span>
                  </span>
                  <Switch
                    id="mcp-monitors-read"
                    checked={mcpMonitorsRead}
                    onCheckedChange={(checked) => {
                      setMcpMonitorsRead(checked);

                      if (!checked) setMcpMonitorsWrite(false);
                    }}
                    aria-label="Read monitors"
                  />
                </label>

                <label
                  className="flex items-center justify-between gap-3"
                  htmlFor="mcp-monitors-write"
                >
                  <span className="flex flex-col gap-0.5">
                    <span className="font-mono text-xs text-mist">manage monitors</span>
                    <span className="font-mono text-[10px] text-mist-faint">
                      Create, update, and delete monitors. Requires read monitors.
                    </span>
                  </span>
                  <Switch
                    id="mcp-monitors-write"
                    checked={mcpMonitorsWrite}
                    onCheckedChange={(checked) => {
                      setMcpMonitorsWrite(checked);

                      if (checked) setMcpMonitorsRead(true);
                    }}
                    aria-label="Manage monitors"
                  />
                </label>
              </div>

              <FieldDescription>
                At least one scope is required. Write access implies read access.
              </FieldDescription>

              {mcpError && <ErrorAlert error={mcpError} />}
            </FieldGroup>

            <DialogFooter className="mt-5">
              <Button type="button" variant="outline" size="sm" onClick={() => setMcpOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={
                  creatingMcp ||
                  !mcpName.trim() ||
                  (!mcpLogs && !mcpMonitorsRead && !mcpMonitorsWrite)
                }
              >
                {creatingMcp && <Spinner data-icon="inline-start" />}
                {creatingMcp ? "creating…" : "Create MCP key"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

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

          {editKey !== null && keyTypeOf(editKey) === "mcp" ? (
            <FieldGroup>
              {MCP_SCOPES.map((scope) => (
                <Field key={scope} orientation="horizontal">
                  <Checkbox
                    id={`edit-${scope}`}
                    checked={editScopes.includes(scope)}
                    onCheckedChange={(checked) => toggleEditScope(scope, checked === true)}
                  />
                  <FieldLabel
                    htmlFor={`edit-${scope}`}
                    className="normal-case tracking-normal text-xs text-mist-dim"
                  >
                    {scope}
                  </FieldLabel>
                </Field>
              ))}
            </FieldGroup>
          ) : (
            <FieldGroup>
              <Field orientation="horizontal">
                <Checkbox
                  id="edit-ingest"
                  checked={editScopes.includes("ingest")}
                  onCheckedChange={(checked) => toggleEditScope("ingest", checked === true)}
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
                  checked={editScopes.includes("query")}
                  onCheckedChange={(checked) => toggleEditScope("query", checked === true)}
                />
                <FieldLabel
                  htmlFor="edit-query"
                  className="normal-case tracking-normal text-xs text-mist-dim"
                >
                  query — read events
                </FieldLabel>
              </Field>
            </FieldGroup>
          )}

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
              disabled={actionBusy || editScopes.length === 0}
              onClick={() => void saveKeyScopes()}
            >
              {actionBusy && <Spinner data-icon="inline-start" />}
              Save permissions
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={createdSecret?.keyType === "mcp"}
        onOpenChange={(open) => {
          if (!open) setCreatedSecret(null);
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Copy this MCP key now — it won&apos;t be shown again</DialogTitle>
            <DialogDescription>
              The secret lives in memory only. Paste the config into your MCP client; after this
              dialog closes, reroll the key if you lose it.
            </DialogDescription>
          </DialogHeader>

          {createdSecret?.keyType === "mcp" && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <code className="break-all rounded-[3px] bg-ink-900 px-2 py-1 font-mono text-[11px] text-mist">
                  {createdSecret.plaintext}
                </code>
                <CopyButton value={createdSecret.plaintext} label="copy key" />
              </div>

              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-mist-faint">
                  client config
                </p>
                <div className="mt-1 flex items-start gap-2">
                  <pre className="max-h-64 min-w-0 flex-1 overflow-auto rounded-[3px] border border-white/[0.08] bg-ink-900 p-2 font-mono text-[10px] leading-relaxed text-mist-dim">
                    {mcpConfigSnippet(createdSecret.plaintext)}
                  </pre>
                  <CopyButton
                    value={mcpConfigSnippet(createdSecret.plaintext)}
                    label="copy config"
                  />
                </div>
              </div>

              <Alert variant="gold">
                <KeyRoundIcon />
                <AlertTitle>Shown once — treat it like a password</AlertTitle>
                <AlertDescription>
                  The key is hashed at rest and cannot be recovered. Revoke it from this page if it
                  leaks. On Windows, MCP clients may need{" "}
                  <code className="text-mist">cmd /c npx</code> as the command.
                </AlertDescription>
              </Alert>
            </div>
          )}

          <DialogFooter>
            <Button size="sm" onClick={() => setCreatedSecret(null)}>
              done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
