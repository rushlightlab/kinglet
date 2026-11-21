import { expect, test } from "@playwright/test";
import { LEGACY_MONITOR_NAME } from "./support/data";
import { cardWithText } from "./support/ui";

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

  const card = cardWithText(page, name);

  await expect(card).toBeVisible();

  await card.getByRole("switch", { name: "Pause monitor" }).click();
  await expect(card.getByRole("switch", { name: "Enable monitor" })).toBeVisible();
  await expect(card.getByText("paused", { exact: true })).toBeVisible();

  await card.getByRole("switch", { name: "Enable monitor" }).click();
  await expect(card.getByRole("switch", { name: "Pause monitor" })).toBeVisible();
  await expect(card.getByText("paused", { exact: true })).toHaveCount(0);

  await card.getByRole("button", { name: "delete", exact: true }).click();

  const confirm = page.getByRole("alertdialog");

  await expect(confirm.getByText(`Delete ${name}?`)).toBeVisible();
  await confirm.getByRole("button", { name: "Delete monitor" }).click();

  await expect(card).toHaveCount(0);
});
