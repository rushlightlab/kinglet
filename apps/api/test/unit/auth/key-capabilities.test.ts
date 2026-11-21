import { describe, expect, it } from "vitest";
import { canCapability, keyCan } from "../../../src/auth/key-capabilities.ts";
import type { AuthInfo } from "../../../src/auth/middleware.ts";
import type { AnyKeyScope, Permission, Role } from "../../../src/auth/roles.ts";

function apiKeyAuth(scopes: AnyKeyScope[]): AuthInfo {
  return {
    kind: "key",
    keyId: "key-1",
    name: "service key",
    projectId: "project-1",
    keyType: "api",
    scopes: new Set(scopes),
  };
}

function mcpKeyAuth(scopes: AnyKeyScope[]): AuthInfo {
  return {
    kind: "key",
    keyId: "key-2",
    name: "mcp key",
    projectId: "project-1",
    keyType: "mcp",
    scopes: new Set(scopes),
  };
}

function userAuth(role: Role, permissions: Permission[]): AuthInfo {
  return {
    kind: "user",
    user: {
      id: "user-1",
      email: "user@example.test",
      name: "User",
      role,
      createdAt: 0,
      updatedAt: 0,
    },
    permissions: new Set(permissions),
  };
}

describe("keyCan for API keys", () => {
  it("maps query to logs.read and ingest to logs.write", () => {
    const queryOnly = apiKeyAuth(["query"]);
    const ingestOnly = apiKeyAuth(["ingest"]);

    expect(keyCan(queryOnly, "logs.read")).toBe(true);
    expect(keyCan(queryOnly, "logs.write")).toBe(false);
    expect(keyCan(ingestOnly, "logs.write")).toBe(true);
    expect(keyCan(ingestOnly, "logs.read")).toBe(false);
  });

  it("never grants monitor capabilities to an API key", () => {
    const key = apiKeyAuth(["ingest", "query"]);

    expect(keyCan(key, "monitors.read")).toBe(false);
    expect(keyCan(key, "monitors.write")).toBe(false);
  });

  it("fails closed when an API key carries a foreign scope", () => {
    expect(keyCan(apiKeyAuth(["logs.read"]), "logs.read")).toBe(false);
    expect(keyCan(apiKeyAuth(["monitors.write"]), "monitors.write")).toBe(false);
  });
});

describe("keyCan for MCP keys", () => {
  it("uses the MCP scope vocabulary", () => {
    const readOnly = mcpKeyAuth(["logs.read"]);

    expect(keyCan(readOnly, "logs.read")).toBe(true);
    expect(keyCan(readOnly, "monitors.read")).toBe(false);
    expect(keyCan(readOnly, "monitors.write")).toBe(false);
  });

  it("grants monitor read and write when both scopes are present", () => {
    const key = mcpKeyAuth(["logs.read", "monitors.read", "monitors.write"]);

    expect(keyCan(key, "monitors.read")).toBe(true);
    expect(keyCan(key, "monitors.write")).toBe(true);
  });

  it("never grants log writes to an MCP key", () => {
    expect(keyCan(mcpKeyAuth(["logs.read", "monitors.write"]), "logs.write")).toBe(false);
    expect(keyCan(mcpKeyAuth(["ingest", "query"]), "logs.write")).toBe(false);
  });
});

describe("canCapability", () => {
  it("delegates session users to their role permissions", () => {
    const viewer = userAuth("viewer", ["logs.read", "monitors.read", "projects.read"]);

    expect(canCapability(viewer, "logs.read")).toBe(true);
    expect(canCapability(viewer, "monitors.read")).toBe(true);
    expect(canCapability(viewer, "logs.write")).toBe(false);
    expect(canCapability(viewer, "monitors.write")).toBe(false);
  });

  it("delegates machine credentials to keyCan", () => {
    expect(canCapability(apiKeyAuth(["query"]), "logs.read")).toBe(true);
    expect(canCapability(mcpKeyAuth(["monitors.read"]), "monitors.read")).toBe(true);
  });

  it("does not treat a user as a key or a key as a user", () => {
    const member = userAuth("member", ["logs.read"]);

    expect(keyCan(member, "logs.read")).toBe(false);
    expect(canCapability(apiKeyAuth(["ingest"]), "logs.write")).toBe(true);
  });
});
