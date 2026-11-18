import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";

export function sha256hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Bearer-token auth for everything under /v1.
 * Tokens are configured via KINGLET_TOKENS (or auto-generated on first boot)
 * and compared as SHA-256 hashes, never stored in plaintext.
 *
 * The SSE endpoint also accepts `?token=` because EventSource cannot send
 * headers. Acceptable for a self-hosted single-tenant v0; swap for
 * short-lived stream tickets when multi-user auth lands.
 */
export function authMiddleware(tokenHashes: Set<string>): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header("authorization");
    let token: string | undefined;
    if (header?.toLowerCase().startsWith("bearer ")) token = header.slice(7).trim();
    if (!token) token = c.req.query("token");
    if (!token || !tokenHashes.has(sha256hex(token))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}
