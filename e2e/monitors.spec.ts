import { expect, test } from "@playwright/test";
import { LEGACY_MONITOR_NAME } from "./support/data";
import { rowAction, tableRow } from "./support/ui";

test("create, pause, resume, and delete a monitor", async ({ page }) => {
  const name = `e2e monitor ${Date.now()}`;

  await page.goto("/monitors");
  await expect(page.getByText(LEGACY_MONITOR_NAME)).toBeVisible();

  await page.getByRole("button", { name: "new monitor" }).click();

  const dialog = page.getByRole("dialog");

  await dialog.getByLabel("name").fill(name);
  await dialog.getByLabel(/query/).fill("e2e needle alpha");
  await dialog.getByRole("button", { name: "Create monitor" }).click();

  await expect(page.getByText("Monitor created")).toBeVisible();

  const row = tableRow(page, name);

  await expect(row).toBeVisible();
  await expect(row).toContainText("spike · > 10 in 5m");

  await row.getByRole("switch", { name: `Pause ${name}` }).click();
  await expect(row.getByRole("switch", { name: `Enable ${name}` })).toBeVisible();
  await expect(row.getByText("paused", { exact: true })).toBeVisible();

  await row.getByRole("switch", { name: `Enable ${name}` }).click();
  await expect(row.getByRole("switch", { name: `Pause ${name}` })).toBeVisible();
  await expect(row.getByText("paused", { exact: true })).toHaveCount(0);

  await rowAction(row, "Delete");

  const confirm = page.getByRole("alertdialog");

  await expect(confirm.getByText(`Delete ${name}?`)).toBeVisible();
  await confirm.getByRole("button", { name: "Delete monitor" }).click();

  await expect(row).toHaveCount(0);
});

test("the monitor search narrows the table and says when nothing matches", async ({ page }) => {
  await page.goto("/monitors");
  await expect(tableRow(page, LEGACY_MONITOR_NAME)).toBeVisible();

  const search = page.getByRole("searchbox", { name: "Search monitors" });

  await search.fill(LEGACY_MONITOR_NAME.toUpperCase());
  await expect(tableRow(page, LEGACY_MONITOR_NAME)).toBeVisible();

  await search.fill("zz-no-such-monitor");
  await expect(tableRow(page, LEGACY_MONITOR_NAME)).toHaveCount(0);
  await expect(page.getByText("No monitors match “zz-no-such-monitor”.")).toBeVisible();

  await page.getByRole("button", { name: "clear search", exact: true }).click();
  await expect(search).toHaveValue("");
  await expect(tableRow(page, LEGACY_MONITOR_NAME)).toBeVisible();
});
