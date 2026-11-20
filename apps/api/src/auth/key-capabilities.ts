/**
 * Capability checks for machine credentials.
 *
 * Routes stop testing raw scope strings and ask one helper. API keys map
 * `query` → `logs.read` and `ingest` → `logs.write`; MCP keys use their own
 * vocabulary. Neither key type ever inherits a human role, and this helper is
 * never true for a session user — users go through `can()`.
 */

import { can } from "./middleware.ts";
import type { AuthInfo } from "./middleware.ts";

export type KeyCapability = "logs.read" | "logs.write" | "monitors.read" | "monitors.write";

/** Users use their role permissions; keys use their scope vocabulary. */
export function canCapability(auth: AuthInfo, capability: KeyCapability): boolean {
  return auth.kind === "user" ? can(auth, capability) : keyCan(auth, capability);
}

export function keyCan(auth: AuthInfo, capability: KeyCapability): boolean {
  if (auth.kind !== "key") return false;

  if (auth.keyType === "api") {
    switch (capability) {
      case "logs.read":
        return auth.scopes.has("query");
      case "logs.write":
        return auth.scopes.has("ingest");
      default:
        return false;
    }
  }

  if (auth.keyType === "mcp") {
    switch (capability) {
      case "logs.read":
        return auth.scopes.has("logs.read");
      // MCP keys are read-only for logs by design; there is no ingest path.
      case "logs.write":
        return false;
      case "monitors.read":
        return auth.scopes.has("monitors.read");
      case "monitors.write":
        return auth.scopes.has("monitors.write");
      default:
        return false;
    }
  }

  return false;
}
