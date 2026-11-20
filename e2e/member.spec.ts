import { expect, test } from "@playwright/test";
import { LEGACY_MONITOR_NAME } from "./support/data";
import { MEMBER_STATE_PATH, readSeed } from "./support/state";

interface MonitorChannel {
  type: string;
  url: string;
}

interface MonitorRecord {
  name: string;
  channels: MonitorChannel[];
  lastError: string | null;
}

interface MonitorsPayload {
  monitors: MonitorRecord[];
}

test.use({ storageState: MEMBER_STATE_PATH });

test("a member sees legacy monitor webhooks masked", async ({ page }) => {
  const seed = readSeed();

  await page.goto("/monitors");
  await expect(page.getByText(LEGACY_MONITOR_NAME)).toBeVisible();
  await expect(page.locator("body")).not.toContainText("legacy-e2e-secret");

  const response = await page.request.get(`/v1/monitors?project=${seed.projects.defaultId}`);

  expect(response.ok()).toBeTruthy();

  const payload: MonitorsPayload = await response.json();
  const legacy = payload.monitors.find((monitor) => monitor.name === LEGACY_MONITOR_NAME);

  if (legacy === undefined) {
    throw new Error("the legacy monitor is missing from the member response");
  }

  expect(legacy.channels).toEqual([{ type: "webhook", url: "hidden" }]);
  expect(legacy.lastError).toBeNull();
});
