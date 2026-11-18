import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import {
  changePassword,
  createKey,
  createProject,
  createUser,
  deleteKey,
  deleteProject,
  deleteUser,
  fetchKeys,
  fetchUsers,
  updateUser,
} from "../api";
import { hasPermission, useApp } from "../app-context";
import type { ApiKeyInfo, AppUser } from "../types";
import SiteHeader from "../components/SiteHeader";

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
    <div className="flex h-screen flex-col bg-ink-950 text-mist">
      <SiteHeader />
      <main className="relative flex-1 overflow-y-auto">
        <div className="k-bg-grid absolute inset-0" aria-hidden="true" />
        <div className="relative mx-auto w-full max-w-3xl px-6 py-8">
          <div className="k-kicker">
            <span className="text-gold">/</span> settings
          </div>
          <h1 className="font-display mt-2 text-2xl font-bold tracking-wide">Workspace.</h1>

          <div className="mt-6 flex items-center gap-1 border-b border-white/[0.08]">
            {tabs
              .filter((t) => t.visible)
              .map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`-mb-px border-b-2 px-3 py-2 font-mono text-xs transition-colors ${
                    tab === t.id
                      ? "border-gold text-gold"
                      : "border-transparent text-mist-dim hover:text-mist"
                  }`}
                >
                  {t.label}
                </button>
              ))}
          </div>

          {tab === "keys" && canKeys && <KeysPanel />}
          {tab === "users" && canUsers && <UsersPanel />}
          {tab === "account" && <AccountPanel />}
        </div>
      </main>
    </div>
  );
}

// ---------- projects + API keys ----------

function KeysPanel() {
  const { currentProjectId, projects, permissions, refreshProjects } = useApp();
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

  const [projectName, setProjectName] = useState("");
  const [confirmDeleteProject, setConfirmDeleteProject] = useState(false);

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

  const revoke = async (key: ApiKeyInfo): Promise<void> => {
    try {
      await deleteKey(key.id, currentProjectId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const addProject = async (): Promise<void> => {
    if (!projectName.trim()) return;
    try {
      await createProject(projectName.trim());
      setProjectName("");
      await refreshProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const removeProject = async (): Promise<void> => {
    try {
      await deleteProject(currentProjectId);
      setConfirmDeleteProject(false);
      await refreshProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="mt-5 flex flex-col gap-3">
      {error && (
        <p className="rounded-[5px] border border-coral/25 bg-coral/[0.05] px-3 py-2 font-mono text-xs text-coral">
          {error}
        </p>
      )}

      <section className="k-card p-4">
        <h2 className="font-display text-[15px] font-semibold tracking-wide">
          API keys — {project?.name ?? "project"}
        </h2>
        <p className="mt-1 font-mono text-xs text-mist-dim">
          Keys are machine credentials with scopes: <span className="text-gold">ingest</span> writes logs,{" "}
          <span className="text-gold">query</span> reads them. The full key is shown once.
        </p>

        {createdKey && (
          <div className="mt-3 rounded-[5px] border border-gold/40 bg-gold/[0.06] p-3">
            <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-gold">
              copy this key now — it won&apos;t be shown again
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <code className="break-all rounded-[3px] bg-ink-900 px-2 py-1 font-mono text-xs text-mist">
                {createdKey}
              </code>
              <button
                onClick={() => void navigator.clipboard?.writeText(createdKey)}
                className="k-chip-btn"
              >
                copy
              </button>
            </div>
          </div>
        )}

        <div className="mt-4 flex flex-col gap-2">
          {keys.map((key) => (
            <div
              key={key.id}
              className="flex flex-wrap items-center gap-2 border-b border-white/[0.04] py-2 font-mono text-xs"
            >
              <span className="text-mist">{key.name}</span>
              <span className="text-mist-faint">{key.prefix}</span>
              {key.scopes.map((scope) => (
                <span
                  key={scope}
                  className="rounded-[3px] border border-gold/25 bg-gold/[0.06] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.12em] text-gold"
                >
                  {scope}
                </span>
              ))}
              <span className="text-[10px] text-mist-faint">
                {key.lastUsedAt ? `last used ${new Date(key.lastUsedAt).toLocaleDateString()}` : "never used"}
              </span>
              {canWriteKeys && (
                <button
                  onClick={() => void revoke(key)}
                  className="k-chip-btn ml-auto hover:!border-coral/35 hover:!text-coral"
                >
                  revoke
                </button>
              )}
            </div>
          ))}
          {keys.length === 0 && (
            <p className="py-3 font-mono text-xs text-mist-faint">No keys for this project yet.</p>
          )}
        </div>

        {canWriteKeys && (
          <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-white/[0.06] pt-4">
            <label className="min-w-40 flex-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-mist-faint">
                key name
              </span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="api-prod"
                className="mt-1 w-full rounded-[5px] border border-white/[0.08] bg-ink-900 px-3 py-2 font-mono text-xs text-mist outline-none transition-colors focus:border-gold/40"
              />
            </label>
            <label className="flex items-center gap-1.5 font-mono text-xs text-mist-dim">
              <input
                type="checkbox"
                checked={scopeIngest}
                onChange={(e) => setScopeIngest(e.target.checked)}
                className="accent-gold"
              />
              ingest
            </label>
            <label className="flex items-center gap-1.5 font-mono text-xs text-mist-dim">
              <input
                type="checkbox"
                checked={scopeQuery}
                onChange={(e) => setScopeQuery(e.target.checked)}
                className="accent-gold"
              />
              query
            </label>
            <button
              onClick={() => void create()}
              disabled={busy || !name.trim() || (!scopeIngest && !scopeQuery)}
              className="k-btn k-btn-primary k-btn-sm disabled:opacity-40"
            >
              create key
            </button>
          </div>
        )}
      </section>

      <section className="k-card p-4">
        <h2 className="font-display text-[15px] font-semibold tracking-wide">Projects</h2>
        <div className="mt-3 flex flex-wrap items-center gap-2 font-mono text-xs">
          {projects.map((p) => (
            <span
              key={p.id}
              className={`rounded-[3px] border px-2 py-0.5 ${
                p.id === currentProjectId
                  ? "border-gold/40 bg-gold/[0.08] text-gold"
                  : "border-white/[0.08] text-mist-dim"
              }`}
            >
              {p.name}
            </span>
          ))}
        </div>
        {canWriteProjects && (
          <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-white/[0.06] pt-4">
            <label className="min-w-40 flex-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-mist-faint">
                new project
              </span>
              <input
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="acme-production"
                className="mt-1 w-full rounded-[5px] border border-white/[0.08] bg-ink-900 px-3 py-2 font-mono text-xs text-mist outline-none transition-colors focus:border-gold/40"
              />
            </label>
            <button
              onClick={() => void addProject()}
              disabled={!projectName.trim()}
              className="k-btn k-btn-ghost k-btn-sm disabled:opacity-40"
            >
              add project
            </button>
            {confirmDeleteProject ? (
              <>
                <button onClick={() => void removeProject()} className="k-chip-btn border-coral/40 text-coral">
                  confirm delete project
                </button>
                <button onClick={() => setConfirmDeleteProject(false)} className="k-chip-btn">
                  cancel
                </button>
              </>
            ) : (
              <button
                onClick={() => setConfirmDeleteProject(true)}
                className="k-chip-btn hover:!border-coral/35 hover:!text-coral"
                title="Delete the current project and all its logs"
              >
                delete current project
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

// ---------- users (admin) ----------

function UsersPanel() {
  const { user } = useApp();
  const [users, setUsers] = useState<AppUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("member");
  const [password, setPassword] = useState("");
  const [createdPassword, setCreatedPassword] = useState<{ email: string; password: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const changeRole = async (target: AppUser, nextRole: string): Promise<void> => {
    try {
      await updateUser(target.id, { role: nextRole });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (id: number): Promise<void> => {
    try {
      await deleteUser(id);
      setConfirmDelete(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="mt-5 flex flex-col gap-3">
      {error && (
        <p className="rounded-[5px] border border-coral/25 bg-coral/[0.05] px-3 py-2 font-mono text-xs text-coral">
          {error}
        </p>
      )}

      {createdPassword && (
        <div className="rounded-[5px] border border-gold/40 bg-gold/[0.06] p-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-gold">
            password for {createdPassword.email} — copy it now
          </div>
          <div className="mt-2 flex items-center gap-2">
            <code className="rounded-[3px] bg-ink-900 px-2 py-1 font-mono text-xs text-mist">
              {createdPassword.password}
            </code>
            <button
              onClick={() => void navigator.clipboard?.writeText(createdPassword.password)}
              className="k-chip-btn"
            >
              copy
            </button>
            <button onClick={() => setCreatedPassword(null)} className="k-chip-btn">
              dismiss
            </button>
          </div>
        </div>
      )}

      <section className="k-card p-4">
        <h2 className="font-display text-[15px] font-semibold tracking-wide">Users</h2>
        <div className="mt-3 flex flex-col">
          {users.map((u) => (
            <div
              key={u.id}
              className="flex flex-wrap items-center gap-3 border-b border-white/[0.04] py-2 font-mono text-xs"
            >
              <span className="text-mist">{u.email}</span>
              <span className="text-mist-faint">{u.name || "—"}</span>
              {u.role === "admin" ? (
                <span className="rounded-[3px] border border-gold/30 bg-gold/[0.06] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.12em] text-gold">
                  admin
                </span>
              ) : (
                <select
                  value={u.role}
                  onChange={(e) => void changeRole(u, e.target.value)}
                  className="cursor-pointer rounded-[3px] border border-white/[0.08] bg-ink-900 px-1.5 py-0.5 font-mono text-[10px] text-mist-dim outline-none focus:border-gold/40"
                >
                  <option value="member">member</option>
                  <option value="viewer">viewer</option>
                </select>
              )}
              {u.id !== user.id && u.role !== "admin" && (
                <>
                  {confirmDelete === u.id ? (
                    <>
                      <button
                        onClick={() => void remove(u.id)}
                        className="k-chip-btn border-coral/40 text-coral"
                      >
                        confirm
                      </button>
                      <button onClick={() => setConfirmDelete(null)} className="k-chip-btn">
                        cancel
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(u.id)}
                      className="k-chip-btn ml-auto hover:!border-coral/35 hover:!text-coral"
                    >
                      delete
                    </button>
                  )}
                </>
              )}
            </div>
          ))}
          {users.length === 0 && (
            <p className="py-3 font-mono text-xs text-mist-faint">No users loaded.</p>
          )}
        </div>

        <div className="mt-4 grid gap-2 border-t border-white/[0.06] pt-4 sm:grid-cols-2">
          <label className="block">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-mist-faint">email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@example.com"
              className="mt-1 w-full rounded-[5px] border border-white/[0.08] bg-ink-900 px-3 py-2 font-mono text-xs text-mist outline-none transition-colors focus:border-gold/40"
            />
          </label>
          <label className="block">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-mist-faint">name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Sam"
              className="mt-1 w-full rounded-[5px] border border-white/[0.08] bg-ink-900 px-3 py-2 font-mono text-xs text-mist outline-none transition-colors focus:border-gold/40"
            />
          </label>
          <label className="block">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-mist-faint">role</span>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="mt-1 w-full cursor-pointer rounded-[5px] border border-white/[0.08] bg-ink-900 px-3 py-2 font-mono text-xs text-mist outline-none focus:border-gold/40"
            >
              <option value="member">member — logs, monitors, keys</option>
              <option value="viewer">viewer — read only</option>
            </select>
          </label>
          <label className="block">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-mist-faint">
              password (blank = generated)
            </span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="optional"
              className="mt-1 w-full rounded-[5px] border border-white/[0.08] bg-ink-900 px-3 py-2 font-mono text-xs text-mist outline-none transition-colors focus:border-gold/40"
            />
          </label>
          <div className="sm:col-span-2">
            <button
              onClick={() => void add()}
              disabled={!email.trim()}
              className="k-btn k-btn-primary k-btn-sm disabled:opacity-40"
            >
              add user
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

// ---------- account ----------

function AccountPanel() {
  const { user } = useApp();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (next !== confirm) {
      setError("new passwords don't match");
      return;
    }
    try {
      await changePassword(current, next);
      setMessage("password updated");
      setError(null);
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setMessage(null);
    }
  };

  return (
    <div className="mt-5 flex flex-col gap-3">
      <section className="k-card p-4">
        <h2 className="font-display text-[15px] font-semibold tracking-wide">Account</h2>
        <p className="mt-2 font-mono text-xs text-mist-dim">
          {user.email} · <span className="text-gold">{user.role}</span>
          {user.name ? ` · ${user.name}` : ""}
        </p>
      </section>

      <section className="k-card p-4">
        <h2 className="font-display text-[15px] font-semibold tracking-wide">Change password</h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <label className="block">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-mist-faint">current</span>
            <input
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              className="mt-1 w-full rounded-[5px] border border-white/[0.08] bg-ink-900 px-3 py-2 font-mono text-xs text-mist outline-none transition-colors focus:border-gold/40"
            />
          </label>
          <label className="block">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-mist-faint">new</span>
            <input
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              className="mt-1 w-full rounded-[5px] border border-white/[0.08] bg-ink-900 px-3 py-2 font-mono text-xs text-mist outline-none transition-colors focus:border-gold/40"
            />
          </label>
          <label className="block">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-mist-faint">confirm</span>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="mt-1 w-full rounded-[5px] border border-white/[0.08] bg-ink-900 px-3 py-2 font-mono text-xs text-mist outline-none transition-colors focus:border-gold/40"
            />
          </label>
        </div>
        {error && <p className="mt-3 font-mono text-xs text-coral">{error}</p>}
        {message && <p className="mt-3 font-mono text-xs text-gold">{message}</p>}
        <button
          onClick={() => void submit()}
          disabled={!current || next.length < 8}
          className="k-btn k-btn-primary k-btn-sm mt-3 disabled:opacity-40"
        >
          update password
        </button>
      </section>
    </div>
  );
}
