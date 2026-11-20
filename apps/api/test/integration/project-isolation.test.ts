import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JsonObject } from "../../src/json.ts";
import { arrayAt, errorOf, jsonBody, messagesOf, objectAt, stringAt } from "../helpers/body.ts";
import { request } from "../helpers/request.ts";
import { createTestSession } from "../helpers/session.ts";
import type { TestSession } from "../helpers/session.ts";

let session: TestSession | null = null;

function ctx(): TestSession {
  if (session === null) throw new Error("project isolation suite: test session missing");

  return session;
}

beforeAll(async () => {
  session = await createTestSession();

  const { harness, data } = session;

  const alpha = await request(harness.app, "/v1/events", {
    method: "POST",
    body: { message: "alpha event", service: "alpha", level: "info" },
    bearer: data.keys.alpha.plaintext,
  });

  const beta = await request(harness.app, "/v1/events", {
    method: "POST",
    body: { message: "beta event", service: "beta", level: "info" },
    bearer: data.keys.beta.plaintext,
  });

  if (alpha.status !== 200 || beta.status !== 200) {
    throw new Error("project isolation suite: fixture ingest failed");
  }
});

afterAll(async () => {
  await session?.close();
  session = null;
});

function projectIds(body: JsonObject): string[] {
  const projects = arrayAt(body.projects, "projects");

  return projects.map((project) => stringAt(objectAt(project, "project").id, "project.id"));
}

describe("project isolation", () => {
  it("scopes an API key's reads to its own project even with a project query", async () => {
    const { harness, data } = ctx();

    const response = await request(harness.app, "/v1/events?project=" + data.projects.beta.id, {
      bearer: data.keys.alpha.plaintext,
    });

    expect(response.status).toBe(200);

    const body = await jsonBody(response);

    for (const event of arrayAt(body.events, "events")) {
      expect(objectAt(event, "event").projectId).toBe(data.projects.alpha.id);
    }

    expect(messagesOf(body)).toContain("alpha event");
    expect(messagesOf(body)).not.toContain("beta event");
  });

  it("does not resolve another project's event by uid for a key", async () => {
    const { harness, data, adminJar } = ctx();

    const betaEvents = await request(harness.app, "/v1/events?project=" + data.projects.beta.id, {
      cookies: adminJar,
    });

    const betaEvent = objectAt(
      arrayAt((await jsonBody(betaEvents)).events, "events")[0],
      "beta event",
    );

    const uid = stringAt(betaEvent.uid, "event.uid");

    const alphaLookup = await request(harness.app, "/v1/events/" + uid, {
      bearer: data.keys.alpha.plaintext,
    });

    expect(alphaLookup.status).toBe(404);
    expect(errorOf(await jsonBody(alphaLookup))).toBe("event not found");

    const betaLookup = await request(harness.app, "/v1/events/" + uid, {
      bearer: data.keys.beta.plaintext,
    });

    expect(betaLookup.status).toBe(200);
    expect(objectAt((await jsonBody(betaLookup)).event, "event").projectId).toBe(
      data.projects.beta.id,
    );
  });

  it("ignores a project query on ingest so a key cannot write across projects", async () => {
    const { harness, data, adminJar } = ctx();

    const ingest = await request(harness.app, "/v1/events?project=" + data.projects.beta.id, {
      method: "POST",
      body: { message: "alpha key leaked write" },
      bearer: data.keys.alpha.plaintext,
    });

    expect(ingest.status).toBe(200);

    const betaEvents = await request(harness.app, "/v1/events?project=" + data.projects.beta.id, {
      cookies: adminJar,
    });

    expect(messagesOf(await jsonBody(betaEvents))).not.toContain("alpha key leaked write");

    const alphaEvents = await request(harness.app, "/v1/events?project=" + data.projects.alpha.id, {
      cookies: adminJar,
    });

    expect(messagesOf(await jsonBody(alphaEvents))).toContain("alpha key leaked write");
  });

  it("shows a member only the projects they are assigned to", async () => {
    const { harness, data, memberJar, adminJar } = ctx();

    const projects = await request(harness.app, "/v1/projects", { cookies: memberJar });
    expect(projects.status).toBe(200);

    const listed = projectIds(await jsonBody(projects));
    expect(listed).toEqual([data.projects.alpha.id]);

    const adminProjects = await request(harness.app, "/v1/projects", { cookies: adminJar });
    const adminListed = projectIds(await jsonBody(adminProjects));

    expect(adminListed).toContain(data.projects.alpha.id);
    expect(adminListed).toContain(data.projects.beta.id);

    const beta = await request(harness.app, "/v1/events?project=" + data.projects.beta.id, {
      cookies: memberJar,
    });

    expect(beta.status).toBe(404);
    expect(errorOf(await jsonBody(beta))).toBe("project not found");

    const fallback = await request(harness.app, "/v1/events", { cookies: memberJar });
    expect(fallback.status).toBe(200);

    for (const event of arrayAt((await jsonBody(fallback)).events, "events")) {
      expect(objectAt(event, "event").projectId).toBe(data.projects.alpha.id);
    }
  });

  it("returns only the key's own project from /v1/context", async () => {
    const { harness, data, memberJar } = ctx();

    const alpha = await request(harness.app, "/v1/context?project=" + data.projects.beta.id, {
      bearer: data.keys.alpha.plaintext,
    });

    expect(alpha.status).toBe(200);

    const alphaBody = await jsonBody(alpha);
    expect(objectAt(alphaBody.project, "project").id).toBe(data.projects.alpha.id);
    expect(JSON.stringify(alphaBody)).not.toContain(data.projects.beta.id);

    const capabilities = objectAt(alphaBody.capabilities, "capabilities");
    expect(capabilities["logs.read"]).toBe(true);
    expect(capabilities["logs.write"]).toBe(true);

    const beta = await request(harness.app, "/v1/context", {
      bearer: data.keys.beta.plaintext,
    });

    expect(beta.status).toBe(200);
    expect(objectAt((await jsonBody(beta)).project, "project").id).toBe(data.projects.beta.id);

    const user = await request(harness.app, "/v1/context", { cookies: memberJar });
    expect(user.status).toBe(403);
    expect(errorOf(await jsonBody(user))).toBe("API key required");
  });

  it("reports MCP keys as read-only for logs", async () => {
    const { harness, data } = ctx();

    const response = await request(harness.app, "/v1/context", {
      bearer: data.keys.mcp.plaintext,
    });

    expect(response.status).toBe(200);

    const body = await jsonBody(response);
    const capabilities = objectAt(body.capabilities, "capabilities");

    expect(objectAt(body.project, "project").id).toBe(data.projects.alpha.id);
    expect(capabilities["logs.read"]).toBe(true);
    expect(capabilities["logs.write"]).toBe(false);
    expect(capabilities["monitors.read"]).toBe(true);
    expect(capabilities["monitors.write"]).toBe(false);
  });
});
