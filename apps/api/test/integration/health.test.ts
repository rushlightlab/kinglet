import { describe, expect, it } from "vitest";
import { isJsonObject } from "../../src/json.js";
import { createTestHarness } from "../helpers/harness.js";

describe("GET /healthz", () => {
  it("reports healthy for a migrated temporary database", async () => {
    const harness = await createTestHarness();

    try {
      const response = await harness.app.request("/healthz");

      expect(response.status).toBe(200);
      const body = await response.json();

      expect(isJsonObject(body)).toBe(true);

      if (!isJsonObject(body)) throw new Error("healthz response was not a JSON object");
      expect(body.ok).toBe(true);
      expect(body.version).toEqual(expect.any(String));
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("cache-control")).toBeNull();
    } finally {
      await harness.close();
    }
  });
});
