import { expect, test } from "@playwright/test";
import { EVENT_NEEDLE, EVENT_STAGING, STAGING_PROJECT_NAME } from "./support/data";
import { logRow } from "./support/ui";

test("switching projects swaps the visible log stream", async ({ page }) => {
  await page.goto("/");
  await expect(logRow(page, EVENT_NEEDLE)).toBeVisible();
  await expect(logRow(page, EVENT_STAGING)).toHaveCount(0);

  const projectSelect = page.getByRole("combobox", { name: "Current project" });

  await projectSelect.click();
  await page.getByRole("option", { name: STAGING_PROJECT_NAME }).click();

  await expect(logRow(page, EVENT_STAGING)).toBeVisible();
  await expect(logRow(page, EVENT_NEEDLE)).toHaveCount(0);

  await projectSelect.click();
  await page.getByRole("option", { name: "default" }).click();

  await expect(logRow(page, EVENT_NEEDLE)).toBeVisible();
  await expect(logRow(page, EVENT_STAGING)).toHaveCount(0);
});
