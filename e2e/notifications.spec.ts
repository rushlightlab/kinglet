import { expect, test } from "@playwright/test";
import { openSettingsTab, rowAction, tableRow } from "./support/ui";

test("a notification channel is created, masked, revealed for editing, and deleted", async ({
  page,
}) => {
  const suffix = Date.now().toString(36);
  const name = `e2e channel ${suffix}`;
  const url = `https://hooks.example.test/e2e-${suffix}`;

  await openSettingsTab(page, "notifications");
  // An empty workspace offers "add your first channel"; otherwise the toolbar has "new channel".
  await page.getByRole("button", { name: /^(new channel|add your first channel)$/ }).click();

  const dialog = page.getByRole("dialog");

  await dialog.getByLabel("name").fill(name);
  await dialog.getByLabel("url").fill(url);
  await dialog.getByRole("button", { name: "Create channel" }).click();

  const row = tableRow(page, name);

  await expect(row).toBeVisible();
  await expect(row.getByText("https://hooks.example.test/…", { exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(url);

  const search = page.getByRole("searchbox", { name: "Search channels" });

  await search.fill(suffix);
  await expect(row).toBeVisible();
  await search.fill("zz-no-such-channel");
  await expect(row).toHaveCount(0);
  await search.press("Escape");
  await expect(row).toBeVisible();

  await rowAction(row, "Edit");

  const editDialog = page.getByRole("dialog");

  await expect(editDialog.getByLabel("url")).toHaveValue(url);
  await editDialog.getByRole("button", { name: "Cancel" }).click();

  await rowAction(row, "Delete");

  const confirm = page.getByRole("alertdialog");

  await expect(confirm.getByText(`Delete ${name}?`)).toBeVisible();
  await confirm.getByRole("button", { name: "Delete channel" }).click();

  await expect(row).toHaveCount(0);
});

test("a Telegram channel is built from its own fields and stays masked", async ({ page }) => {
  const suffix = Date.now().toString(36);
  const name = `e2e telegram ${suffix}`;
  // Fake token: shaped to pass the format check only.
  const token = `123456:FAKE_fake_FAKE_fake_${suffix}`;

  await openSettingsTab(page, "notifications");
  await page.getByRole("button", { name: /^(new channel|add your first channel)$/ }).click();

  const dialog = page.getByRole("dialog");

  await dialog.getByLabel("name").fill(name);
  await dialog.getByLabel("type").click();
  await page.getByRole("option", { name: "Telegram" }).click();
  await dialog.getByLabel("bot token").fill(token);
  await dialog.getByLabel("chat ID").fill("-1001234567890");
  await dialog.getByRole("button", { name: "Create channel" }).click();

  const row = tableRow(page, name);

  await expect(row).toBeVisible();
  await expect(row).toContainText("Telegram");
  await expect(page.locator("body")).not.toContainText(token);

  await rowAction(row, "Edit");

  const edit = page.getByRole("dialog");

  await expect(edit.getByLabel("chat ID")).toHaveValue("-1001234567890");
  await expect(edit.getByLabel("bot token")).toHaveValue(token);
  await edit.getByRole("button", { name: "Cancel" }).click();

  await rowAction(row, "Delete");
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete channel" }).click();
  await expect(row).toHaveCount(0);
});
