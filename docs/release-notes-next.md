# Release notes draft: next release

Paste the section below into the GitHub Release body when the next version is
tagged; the docs changelog is generated from that body. The full list of
breaking changes with fixes lives on the docs site at `/upgrading/`.

---

### Before you upgrade

- **`KINGLET_SECRET_KEY` must be random bytes** (hex or canonical base64, at least 32 bytes, as from `openssl rand -base64 32`). A passphrase now stops startup. If yours was a passphrase, note each channel's target while still on 0.5.0, then set a new key and re-enter them after upgrading.
- **Docker Compose now publishes port 8080 on loopback only** (`127.0.0.1:8080:3000`), because Docker-published ports bypass host firewalls. Put a TLS proxy in front, or change the mapping back if other machines must connect directly.
- **First boot rewrites per-event storage sizes** (migration 0013). `KINGLET_MAX_PROJECT_DB_MB` is now charged from each project's own rows, search index included, so other projects can't push yours over its cap. Projects near their cap may cross it; raise the cap if needed. Back up before upgrading.
- **The MCP server needs HTTPS** for any host other than localhost (`KINGLET_MCP_ALLOW_INSECURE_HTTP=1` for trusted private networks), and the MCP server and SDKs no longer follow redirects: point `KINGLET_URL` at the final address.

### Breaking changes

- Only `sign-in/email`, `sign-out`, `get-session`, and `change-password` are served under `/api/auth/*`; other Better Auth paths return `404`.
- API and MCP keys stop working once their creator is no longer an admin or a member of the key's project.
- Local dev origins (`localhost:5173` and similar) are accepted for cookie mutations only when `KINGLET_BASE_URL` is local.
- An empty `Authorization: Bearer` header no longer skips the CSRF check.
- With `KINGLET_ALLOW_PRIVATE_WEBHOOKS=1`, only admins can test private or loopback targets.
- A monitor unlinked from a migrated channel no longer sends to that destination through its legacy copy; link the channel again.
- Demoting a user to viewer removes their clear-logs grants.
- Malformed NDJSON lines count toward the 10,000-line batch cap.
- Archive import stops with `507` once the database reaches `KINGLET_MAX_DB_MB`; rerun it after freeing space.
- `404` responses no longer include the request path.

### Security and limits

- One NDJSON request of invalid lines can no longer stall the server for seconds.
- Keys created while a demotion or ban was in progress are revoked, and can't return after an unban.
- Unknown `/api/auth` paths no longer grow the in-memory rate limiter.
- Free-text search uses the shared index only when that is cheaper than scanning the caller's own rows.
- Reads that return admin secrets (channel targets, snapshot downloads) skip the 60-second session cache.
- Snapshots no longer contain session or verification tokens; restore downloads stop at the manifest size.
- Notification text drops C1 controls and bidi overrides, Slack escapes `&`, and the 6to4 relay range is blocked.
- Release workflows publish only commits that are already on `main`.
