import { expect, test } from "@playwright/test";
import {
  DRAWER_ORDER_ID,
  EVENT_CHECKOUT_OK,
  EVENT_DRAWER,
  EVENT_NEEDLE,
  EVENT_OTHER_ERROR,
} from "./support/data";
import { readSeed } from "./support/state";
import { logRow } from "./support/ui";

test("search and filters narrow the log table", async ({ page }) => {
  await page.goto("/");

  await expect(logRow(page, EVENT_NEEDLE)).toBeVisible();
  await expect(logRow(page, EVENT_CHECKOUT_OK)).toBeVisible();

  const filter = page.getByPlaceholder("level:error service:api");

  await filter.fill(`"${EVENT_NEEDLE}"`);
  await filter.press("Enter");

  await expect(logRow(page, EVENT_NEEDLE)).toBeVisible();
  await expect(logRow(page, EVENT_CHECKOUT_OK)).toHaveCount(0);

  await filter.fill("level:error service:checkout");
  await filter.press("Enter");

  await expect(logRow(page, EVENT_NEEDLE)).toBeVisible();
  await expect(logRow(page, EVENT_OTHER_ERROR)).toHaveCount(0);
});

test("the event drawer shows the message, service, and fields", async ({ page }) => {
  await page.goto("/");
  await expect(logRow(page, EVENT_DRAWER)).toBeVisible();

  await logRow(page, EVENT_DRAWER).click();

  const drawer = page.getByRole("complementary");

  await expect(drawer).toBeVisible();
  await expect(drawer.getByText(EVENT_DRAWER)).toBeVisible();
  await expect(drawer.getByText("worker", { exact: true })).toBeVisible();
  await expect(drawer.getByText(DRAWER_ORDER_ID)).toBeVisible();

  await drawer.getByRole("button", { name: "Close" }).click();
  await expect(drawer).toHaveCount(0);
});

test("the live tail renders a newly ingested event", async ({ page }) => {
  const seed = readSeed();

  await page.goto("/");
  await expect(page.getByRole("switch", { name: "live" })).toHaveAttribute("aria-checked", "true");
  await expect(logRow(page, EVENT_NEEDLE)).toBeVisible();
  // Give the SSE subscription a moment to open before publishing.
  await page.waitForTimeout(500);

  const message = `e2e live gamma ${seed.runId} ${Date.now()}`;

  const response = await page.request.post("/v1/events", {
    headers: { authorization: `Bearer ${seed.apiKey}` },
    data: { message, level: "info", service: "live-e2e", env: "e2e" },
  });

  expect(response.ok()).toBeTruthy();
  await expect(logRow(page, message)).toBeVisible({ timeout: 15_000 });
});
