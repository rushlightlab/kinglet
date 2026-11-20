import fs from "node:fs";
import { request } from "@playwright/test";
import type { APIRequestContext, FullConfig } from "@playwright/test";
import { apiSignIn, requireOk } from "./support/api";
import {
  ACCOUNT_EMAIL,
  ACCOUNT_PASSWORD,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  DEFAULT_PROJECT_NAME,
  DRAWER_ORDER_ID,
  EVENT_CHECKOUT_OK,
  EVENT_DRAWER,
  EVENT_NEEDLE,
  EVENT_NOISE,
  EVENT_OTHER_ERROR,
  EVENT_STAGING,
  LEGACY_MONITOR_NAME,
  LEGACY_WEBHOOK_URL,
  MEMBER_EMAIL,
  MEMBER_PASSWORD,
  STAGING_PROJECT_NAME,
} from "./support/data";
import { ADMIN_STATE_PATH, E2E_DIR, MEMBER_STATE_PATH, SEED_PATH } from "./support/state";
import type { SeedState } from "./support/state";

interface ProjectRow {
  id: string;
  name: string;
}

interface ProjectsPayload {
  projects: ProjectRow[];
}

interface CreatedProject {
  project: ProjectRow;
}

interface CreatedKey {
  plaintext: string;
}

interface CreatedUser {
  user: {
    id: string;
  };
}

interface IngestResponse {
  accepted: number;
}

async function waitForHealth(baseURL: string): Promise<void> {
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseURL}/healthz`);

      if (response.ok) return;
    } catch {
      // The API is still booting.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error("the E2E API did not become healthy");
}

async function createUser(
  admin: APIRequestContext,
  email: string,
  password: string,
  role: string,
  name: string,
): Promise<string> {
  const response = await admin.post("/v1/users", {
    data: { email, password, role, name },
  });

  await requireOk(response, `create ${role} user ${email}`);
  const created: CreatedUser = await response.json();

  if (!created.user.id) throw new Error(`creating ${email} returned no user id`);

  return created.user.id;
}

async function addProjectMember(
  admin: APIRequestContext,
  projectId: string,
  userId: string,
): Promise<void> {
  const response = await admin.post(`/v1/projects/${projectId}/members`, {
    data: { userId },
  });

  await requireOk(response, "add project member");
}

/**
 * Seeds a fresh database through the real HTTP API. Nothing here reaches an
 * external network: the monitor is disabled and no notification is sent.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;

  if (baseURL === undefined) {
    throw new Error("Playwright config is missing use.baseURL for the E2E server");
  }

  fs.mkdirSync(E2E_DIR, { recursive: true, mode: 0o700 });
  fs.rmSync(ADMIN_STATE_PATH, { force: true });
  fs.rmSync(MEMBER_STATE_PATH, { force: true });
  fs.rmSync(SEED_PATH, { force: true });

  await waitForHealth(baseURL);

  const admin = await request.newContext({
    baseURL,
    extraHTTPHeaders: { origin: baseURL, "x-kinglet-request": "1" },
  });

  let ingest: APIRequestContext | null = null;

  try {
    await apiSignIn(admin, ADMIN_EMAIL, ADMIN_PASSWORD);

    const projectsResponse = await admin.get("/v1/projects");

    await requireOk(projectsResponse, "list seeded projects");

    const projects: ProjectsPayload = await projectsResponse.json();

    const defaultProject = projects.projects.find(
      (project) => project.name === DEFAULT_PROJECT_NAME,
    );

    if (defaultProject === undefined) {
      throw new Error(`the boot project "${DEFAULT_PROJECT_NAME}" is missing`);
    }

    let stagingProject = projects.projects.find((project) => project.name === STAGING_PROJECT_NAME);

    if (stagingProject === undefined) {
      const createdResponse = await admin.post("/v1/projects", {
        data: { name: STAGING_PROJECT_NAME },
      });

      await requireOk(createdResponse, "create staging project");
      const created: CreatedProject = await createdResponse.json();

      stagingProject = created.project;
    }

    const keyResponse = await admin.post(`/v1/projects/${defaultProject.id}/keys`, {
      data: { name: "e2e seed ingest", scopes: ["ingest", "query"] },
    });

    await requireOk(keyResponse, "create seed API key");
    const createdKey: CreatedKey = await keyResponse.json();

    if (!createdKey.plaintext.startsWith("kl_")) {
      throw new Error("the seed API key response did not contain a kl_ key");
    }

    ingest = await request.newContext({
      baseURL,
      extraHTTPHeaders: { authorization: `Bearer ${createdKey.plaintext}` },
    });

    const baseTs = Date.now() - 5_000;

    const defaultEvents = [
      {
        message: EVENT_NEEDLE,
        level: "error",
        service: "checkout",
        env: "e2e",
        ts: baseTs + 1_000,
      },
      {
        message: EVENT_CHECKOUT_OK,
        level: "info",
        service: "checkout",
        env: "e2e",
        ts: baseTs + 2_000,
      },
      {
        message: EVENT_NOISE,
        level: "debug",
        service: "api",
        env: "e2e",
        ts: baseTs + 3_000,
      },
      {
        message: EVENT_OTHER_ERROR,
        level: "error",
        service: "api",
        env: "e2e",
        ts: baseTs + 4_000,
      },
      {
        message: EVENT_DRAWER,
        level: "info",
        service: "worker",
        env: "e2e",
        ts: baseTs + 5_000,
        fields: { orderId: DRAWER_ORDER_ID, detail: "drawer payload", status: 500 },
      },
    ];

    const ingestResponse = await ingest.post("/v1/events", {
      data: { events: defaultEvents },
    });

    await requireOk(ingestResponse, "seed default-project events");
    const ingestResult: IngestResponse = await ingestResponse.json();

    if (ingestResult.accepted !== defaultEvents.length) {
      throw new Error(`seeded ${ingestResult.accepted} of ${defaultEvents.length} events`);
    }

    const stagingIngest = await admin.post(`/v1/events?project=${stagingProject.id}`, {
      data: {
        events: [
          {
            message: EVENT_STAGING,
            level: "warn",
            service: "api",
            env: "staging",
            ts: Date.now(),
          },
        ],
      },
    });

    await requireOk(stagingIngest, "seed staging-project events");

    // Disabled on purpose: the inline legacy destination must never be
    // contacted by the monitor engine during an E2E run.
    const monitorResponse = await admin.post(`/v1/monitors?project=${defaultProject.id}`, {
      data: {
        name: LEGACY_MONITOR_NAME,
        query: "level:error",
        kind: "match",
        enabled: false,
        channels: [{ type: "webhook", url: LEGACY_WEBHOOK_URL }],
      },
    });

    await requireOk(monitorResponse, "seed legacy monitor");

    const memberId = await createUser(admin, MEMBER_EMAIL, MEMBER_PASSWORD, "member", "E2E Member");

    const accountId = await createUser(
      admin,
      ACCOUNT_EMAIL,
      ACCOUNT_PASSWORD,
      "viewer",
      "E2E Account",
    );

    await addProjectMember(admin, defaultProject.id, memberId);
    await addProjectMember(admin, defaultProject.id, accountId);

    const runId = Date.now().toString(36);

    const seed: SeedState = {
      baseURL,
      runId,
      projects: {
        defaultId: defaultProject.id,
        stagingId: stagingProject.id,
      },
      apiKey: createdKey.plaintext,
    };

    fs.writeFileSync(SEED_PATH, JSON.stringify(seed, null, 2), { mode: 0o600 });
  } finally {
    if (ingest !== null) await ingest.dispose();

    await admin.dispose();
  }
}
