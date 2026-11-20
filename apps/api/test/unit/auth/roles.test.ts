import { describe, expect, it } from "vitest";
import { PASSWORD_MIN_LENGTH, passwordProblem } from "../../../src/auth/password.ts";
import {
  isKeyScope,
  isKeyType,
  isMcpKeyScope,
  isRole,
  KEY_SCOPES,
  MCP_KEY_SCOPES,
  PERMISSIONS,
  permissionsForRole,
  ROLES,
  ROLE_PERMISSIONS,
  scopesForType,
  validateKeyScopes,
} from "../../../src/auth/roles.ts";

describe("roles", () => {
  it("recognizes exactly the three built-in roles", () => {
    expect(ROLES).toEqual(["admin", "member", "viewer"]);

    for (const role of ROLES) {
      expect(isRole(role)).toBe(true);
    }

    expect(isRole("owner")).toBe(false);
    expect(isRole("")).toBe(false);
    expect(isRole(null)).toBe(false);
    expect(isRole(1)).toBe(false);
  });

  it("gives admin every permission", () => {
    expect(permissionsForRole("admin")).toEqual([...PERMISSIONS]);
  });

  it("keeps member and viewer within their least-privilege sets", () => {
    const member = permissionsForRole("member");
    const viewer = permissionsForRole("viewer");

    expect(member).toEqual([
      "logs.read",
      "logs.write",
      "monitors.read",
      "monitors.write",
      "keys.read",
      "keys.write",
      "projects.read",
    ]);
    expect(viewer).toEqual(["logs.read", "monitors.read", "projects.read"]);
    expect(member).not.toContain("users.read");
    expect(member).not.toContain("backups.write");
    expect(viewer).not.toContain("logs.write");
    expect(viewer).not.toContain("keys.read");
  });

  it("returns a fresh permission list so callers cannot mutate the role map", () => {
    const permissions = permissionsForRole("viewer");

    permissions.push("users.write");

    expect(permissionsForRole("viewer")).toEqual([...ROLE_PERMISSIONS.viewer]);
    expect(permissionsForRole("viewer")).not.toContain("users.write");
  });
});

describe("key scope vocabulary", () => {
  it("keeps API and MCP scopes disjoint", () => {
    expect(KEY_SCOPES).toEqual(["ingest", "query"]);
    expect(MCP_KEY_SCOPES).toEqual(["logs.read", "monitors.read", "monitors.write"]);

    for (const scope of KEY_SCOPES) {
      expect(isKeyScope(scope)).toBe(true);
      expect(isMcpKeyScope(scope)).toBe(false);
    }

    for (const scope of MCP_KEY_SCOPES) {
      expect(isMcpKeyScope(scope)).toBe(true);
      expect(isKeyScope(scope)).toBe(false);
    }

    expect(isKeyScope("logs.read")).toBe(false);
    expect(isMcpKeyScope("ingest")).toBe(false);
    expect(isKeyScope("")).toBe(false);
    expect(isMcpKeyScope(null)).toBe(false);
  });

  it("returns the scope set for each key type", () => {
    expect(scopesForType("api")).toEqual(KEY_SCOPES);
    expect(scopesForType("mcp")).toEqual(MCP_KEY_SCOPES);
  });

  it("recognizes key types", () => {
    expect(isKeyType("api")).toBe(true);
    expect(isKeyType("mcp")).toBe(true);
    expect(isKeyType("human")).toBe(false);
    expect(isKeyType(undefined)).toBe(false);
  });

  it("accepts valid API scopes and deduplicates them", () => {
    expect(validateKeyScopes("api", ["ingest", "query"])).toEqual(["ingest", "query"]);
    expect(validateKeyScopes("api", ["query", "query"])).toEqual(["query"]);
    expect(validateKeyScopes("api", [])).toEqual([]);
  });

  it("rejects MCP scopes on API keys and API scopes on MCP keys", () => {
    expect(validateKeyScopes("api", ["monitors.read"])).toBeNull();
    expect(validateKeyScopes("api", ["ingest", "logs.read"])).toBeNull();
    expect(validateKeyScopes("mcp", ["ingest"])).toBeNull();
    expect(validateKeyScopes("mcp", ["logs.write"])).toBeNull();
    expect(validateKeyScopes("mcp", ["logs.read", "ingest"])).toBeNull();
  });

  it("rejects unknown values in a scope list", () => {
    expect(validateKeyScopes("api", ["ingest", "bogus"])).toBeNull();
    expect(validateKeyScopes("mcp", ["logs.read", ""])).toBeNull();
    expect(validateKeyScopes("api", [42])).toBeNull();
  });

  it("adds monitors.read whenever monitors.write is granted to an MCP key", () => {
    expect(validateKeyScopes("mcp", ["monitors.write"])).toEqual([
      "monitors.write",
      "monitors.read",
    ]);
    expect(validateKeyScopes("mcp", ["monitors.read", "monitors.write"])).toEqual([
      "monitors.read",
      "monitors.write",
    ]);
    expect(validateKeyScopes("mcp", ["logs.read"])).toEqual(["logs.read"]);
  });
});

describe("password policy", () => {
  it("requires at least 12 characters", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    expect(passwordProblem("Short1A")).toBe("password must be at least 12 characters");
    expect(passwordProblem("CorrectHorse1")).toBeNull();
  });

  it("requires lowercase, uppercase, and numeric characters", () => {
    expect(passwordProblem("ALLUPPERCASE1")).toBe("password must include a lowercase letter");
    expect(passwordProblem("alllowercase1")).toBe("password must include an uppercase letter");
    expect(passwordProblem("NoNumbersHere")).toBe("password must include a number");
  });

  it("accepts symbols and long passwords", () => {
    expect(passwordProblem("Correct-Horse-1!")).toBeNull();
    expect(passwordProblem("aB3$".repeat(10))).toBeNull();
  });
});
