import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

interface Created {
  id: string;
  name: string;
  key: string;
}

/** A throwaway project with its own key, so clearing never touches shared seed data. */
async function createProject(request: APIRequestContext, origin: string): Promise<Created> {
  const headers = { origin, "x-kinglet-request": "1" };
  const name = `clear-e2e-${Date.now()}`;

  const project = await request.post("/v1/projects", { headers, data: { name } });

  expect(project.ok()).toBeTruthy();

  const projectBody: { project?: { id: string } } = await project.json();
  const id = projectBody.project?.id ?? "";

  const key = await request.post(`/v1/projects/${id}/keys`, {
    headers,
    data: { name: "clear-e2e", scopes: ["ingest", "query"] },
  });

  expect(key.ok()).toBeTruthy();

  const keyBody: { plaintext: string } = await key.json();

  return { id, name, key: keyBody.plaintext };
}

test("clearing by service previews and deletes only that service's events", async ({ page }) => {
  await page.goto("/");
  const origin = new URL(page.url()).origin;
  const project = await createProject(page.request, origin);
  const auth = { authorization: `Bearer ${project.key}` };

  const ingest = await page.request.post("/v1/events", {
    headers: auth,
    data: [
      { message: "clear-e2e worker one", service: "worker" },
      { message: "clear-e2e worker two", service: "worker" },
      { message: "clear-e2e api keeps", service: "api" },
    ],
  });

  expect(ingest.ok()).toBeTruthy();

  await page.goto(`/projects/${project.id}`);
  await page.getByRole("button", { name: "clear project logs" }).click();

  const dialog = page.getByRole("alertdialog");

  await dialog.getByLabel("time").click();
  await page.getByRole("option", { name: "all time" }).click();
  await dialog.getByLabel("service").click();
  await page.getByRole("option", { name: "worker" }).click();

  const preview = dialog.getByRole("region", { name: "Clear preview" });

  await expect(preview).toContainText("2 events will be deleted");
  await expect(preview).toContainText("service:worker");
  await expect(preview).toContainText("clear-e2e worker");
  await expect(preview).not.toContainText("clear-e2e api keeps");

  await dialog.getByLabel(`type ${project.name} to confirm`).fill(project.name);
  await dialog.getByRole("button", { name: "Delete 2 events" }).click();
  await expect(dialog).toHaveCount(0);

  const remaining = await page.request.get("/v1/events", { headers: auth });
  const body: { events: { message: string }[] } = await remaining.json();

  expect(body.events.map((event) => event.message)).toEqual(["clear-e2e api keeps"]);
});
