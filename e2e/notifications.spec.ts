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
