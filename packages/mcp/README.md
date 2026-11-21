# @kinglet/mcp

MCP (Model Context Protocol) server for [Kinglet](https://kinglet.rushlightlab.com).
It lets AI clients search logs and manage monitors in one Kinglet project over a
local stdio connection.

Run it with `npx -y @kinglet/mcp`, and pin the version you reviewed in
production, for example `npx -y @kinglet/mcp@0.3.0`.

## Requirements

- Node.js 26 or newer, matching the Kinglet server and workspace toolchain.
- A running Kinglet server reachable over HTTP(S).
- An **MCP key** (`km_…`) created in that project's settings. A regular API key
  (`kl_…`) is rejected with a pointer to MCP keys.

The MCP server is a client of the public Kinglet HTTP API. It never opens the
database, never ingests logs, and never inherits a human role.

## Configuration

| Variable                 | Required | Description                                                                 |
| ------------------------ | -------- | --------------------------------------------------------------------------- |
| `KINGLET_URL`            | yes      | Base URL, e.g. `https://logs.example.com`. Must be `http://` or `https://`. |
| `KINGLET_MCP_KEY`        | yes      | MCP key starting with `km_…`. Project-bound.                                |
| `KINGLET_MCP_TIMEOUT_MS` | no       | Per-request timeout in ms. Default `15000` (1s–300s).                       |

The URL may include a path prefix (for example `https://example.com/kinglet`)
but not credentials, a query string, or a fragment. Use HTTPS outside local
development.

Never commit the key or paste it into a shared config. The server never prints
it; tool-call audit lines go to stderr and contain only the tool name, duration,
status, and row count.

## Client setup

### Claude Desktop

`claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "kinglet": {
      "command": "npx",
      "args": ["-y", "@kinglet/mcp@0.3.0"],
      "env": {
        "KINGLET_URL": "https://logs.example.com",
        "KINGLET_MCP_KEY": "km_..."
      }
    }
  }
}
```

On Windows, wrap the command:

```json
{
  "mcpServers": {
    "kinglet": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@kinglet/mcp@0.3.0"],
      "env": {
        "KINGLET_URL": "https://logs.example.com",
        "KINGLET_MCP_KEY": "km_..."
      }
    }
  }
}
```

### Claude Code

Add it from a terminal. The command line itself contains the key, so prefer a
project-scoped `.mcp.json` with `${KINGLET_MCP_KEY}` where your client supports
environment expansion, or clear the shell history entry afterward:

```bash
claude mcp add kinglet \
  --env KINGLET_URL=https://logs.example.com \
  --env KINGLET_MCP_KEY=km_... \
  -- npx -y @kinglet/mcp@0.3.0
```

Or commit a project-scoped `.mcp.json` with the same `mcpServers` shape shown
for Claude Desktop. Prefer `${KINGLET_MCP_KEY}` environment expansion, where the
client supports it, over a literal secret.

### Cursor

`.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "kinglet": {
      "command": "npx",
      "args": ["-y", "@kinglet/mcp@0.3.0"],
      "env": {
        "KINGLET_URL": "https://logs.example.com",
        "KINGLET_MCP_KEY": "km_..."
      }
    }
  }
}
```

### VS Code

`.vscode/mcp.json`:

```json
{
  "servers": {
    "kinglet": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@kinglet/mcp@0.3.0"],
      "env": {
        "KINGLET_URL": "https://logs.example.com",
        "KINGLET_MCP_KEY": "km_..."
      }
    }
  }
}
```

VS Code supports `inputs` for secrets; use them instead of a literal key when
the config is shared.

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.kinglet]
command = "npx"
args = ["-y", "@kinglet/mcp@0.3.0"]
env = { KINGLET_URL = "https://logs.example.com", KINGLET_MCP_KEY = "km_..." }
```

On Windows, use `command = "cmd"` and `args = ["/c", "npx", "-y", "@kinglet/mcp@0.3.0"]`.

### Generic stdio

Any MCP client that can launch a command with environment variables works:

```
command: npx
args:    -y @kinglet/mcp
env:     KINGLET_URL=https://logs.example.com
         KINGLET_MCP_KEY=km_...
```

### Run from a checkout

To try unreleased changes, build it from a Kinglet checkout:

```bash
pnpm --filter @kinglet/mcp build
```

Then use `node` with the absolute path to `packages/mcp/dist/cli.js`:

```json
{
  "mcpServers": {
    "kinglet": {
      "command": "node",
      "args": ["C:\\path\\to\\kinglet\\packages\\mcp\\dist\\cli.js"],
      "env": {
        "KINGLET_URL": "http://localhost:3000",
        "KINGLET_MCP_KEY": "km_..."
      }
    }
  }
}
```

## Tools

All tools are scoped to the key's project. Row and group limits cap the returned
rows/groups at 50 by default and 200 maximum; they do not cap
`count_events.total`, which is the full match count. Responses are capped at
256 KiB, messages at 4 KiB, and each event's `fields` object at 8 KiB.
Truncated responses set `truncated: true` and `search_events` returns a
`nextCursor` for paging.

| Tool                | Scope             | Kind        | Returns                                                                   |
| ------------------- | ----------------- | ----------- | ------------------------------------------------------------------------- |
| `get_context`       | any valid MCP key | read        | Project id/name/slug, key metadata, capabilities, version/retention       |
| `search_events`     | `logs.read`       | read        | Events for a filter and time range, newest first, cursor; optional fields |
| `get_event`         | `logs.read`       | read        | One event by `uid`                                                        |
| `get_event_context` | `logs.read`       | read        | One event plus `before`/`after` neighbours in `(ts, id)` order            |
| `get_histogram`     | `logs.read`       | read        | Bucket counts for a filter and time range                                 |
| `list_services`     | `logs.read`       | read        | Services with event counts                                                |
| `count_events`      | `logs.read`       | read        | Effective `from`/`to`, total, and optional `service`/`level`/`env` groups |
| `list_monitors`     | `monitors.read`   | read        | Monitors, state, last evaluation, channel summaries                       |
| `get_monitor`       | `monitors.read`   | read        | One monitor                                                               |
| `list_alerts`       | `monitors.read`   | read        | Recent alerts; optional monitor/state/time filters                        |
| `get_alert`         | `monitors.read`   | read        | One alert by id, with the same masking rules                              |
| `list_channels`     | `monitors.read`   | read        | Channel id/name/type/enabled/health only                                  |
| `create_monitor`    | `monitors.write`  | write       | Creates a monitor; channels are `channelIds`, never URLs                  |
| `update_monitor`    | `monitors.write`  | write       | Partial update by id                                                      |
| `delete_monitor`    | `monitors.write`  | destructive | Deletes a monitor and its alert history                                   |

`monitors.write` implies `monitors.read`. MCP keys never have `logs.write`.
Monitor write tools are registered only when the key has `monitors.write` and
the server sets `KINGLET_MCP_ALLOW_MONITOR_WRITES=1`; hiding a tool is UX only,
and every write remains API-authorized. A newer MCP package against an older
server without `monitorWritesEnabled` stays read-only until the server is
upgraded; restart the MCP client after a transient context failure.
`search_events` accepts an optional `fields` list (`id`, `uid`, `ts`, `level`,
`service`, `env`, `message`, `fields`; max 8, unique) to return only those keys.
Projection never changes `nextCursor` or the underlying query.
`get_event_context` takes `before`/`after` (0–20, default 5) and keeps each
neighbour list chronological. If the payload exceeds the 256 KiB cap, retry with
smaller `before`/`after`.
`list_alerts` time filters are optional: with `from`/`to` omitted, alert history
remains all-time and is capped by `limit`. Capabilities are per-key, so a
`monitors.read`-only key gets the same hidden summary/sample projection as the
HTTP route.

Deliberately absent: ingest, clear logs, project/user/key management, backups,
restore, archive, notification-channel administration, settings, arbitrary SQL,
shell, and outbound fetch.

## Security notes

- **Logs leave your infrastructure.** Every tool result is sent to the AI
  provider configured in your client. Logs can contain personal data, tokens, or
  regulated data; point the MCP key at a project whose contents are appropriate
  for that provider, and apply retention accordingly.
- **Event content is untrusted.** Messages and fields are attacker-controlled
  data, not instructions. The server never executes or acts on text found in
  events, and the system prompt tells the model to treat it as data, but prompt
  injection defense ultimately depends on the client/model. Be cautious with
  agents that can take follow-up actions.
- **Keys are project-bound machine credentials.** A `km_` key cannot inherit a
  human role, cross projects, mint keys, administer users, or reach admin routes.
  Revoke or rotate it in project settings; the change applies on the next
  request. The key is hashed at rest and every use updates `last_used_at`.
- **Channel URLs are secrets.** Monitor read tools return channel id, name, type,
  enabled, and coarse health only. Monitor writes accept `channelIds`; URLs are
  rejected by the input schema. Notification errors are not returned.
- **Rate limit.** MCP requests are limited server-side to 60 per minute per key
  with a burst of 10. `429` means back off; there are no automatic retries.
- **Transport.** v1 is local stdio only. Remote HTTP/OAuth is not implemented;
  remote-only clients need the deferred `/mcp` endpoint.

## Troubleshooting

- `KINGLET_MCP_KEY looks like an API key (kl_)`: create an MCP key (`km_`) in
  the project's key settings. API keys cannot be used with MCP.
- `the MCP key is missing the scope required for this tool`: recreate the key
  with the scope shown in the tool table (or update its scopes).
- `401` / `Kinglet rejected the MCP key`: the key was revoked or rotated, or its
  owner was disabled.
- `404` from `list_channels`: the Kinglet server predates the notification
  summary route. Upgrade the server.
- Nothing appears in the client: run the command with the same env directly and
  read stderr; stdout is reserved for MCP frames.

## License

MIT. See [LICENSE](./LICENSE).
