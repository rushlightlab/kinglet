import { expect, test } from "@playwright/test";
import { openSettingsTab, cardWithText } from "./support/ui";

test("a notification channel is created, masked, revealed for editing, and deleted", async ({
  page,
}) => {
  const suffix = Date.now().toString(36);
  const name = `e2e channel ${suffix}`;
  const url = `https://hooks.example.test/e2e-${suffix}`;

  await openSettingsTab(page, "notifications");
  await page.getByRole("button", { name: "new channel" }).click();

  const dialog = page.getByRole("dialog");

  await dialog.getByLabel("name").fill(name);
  await dialog.getByLabel("url").fill(url);
  await dialog.getByRole("button", { name: "Create channel" }).click();

  const card = cardWithText(page, name);

  await expect(card).toBeVisible();
  await expect(card.getByText("https://hooks.example.test/…", { exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(url);

  await card.getByRole("button", { name: "edit" }).click();

  const editDialog = page.getByRole("dialog");

  await expect(editDialog.getByLabel("url")).toHaveValue(url);
  await editDialog.getByRole("button", { name: "Cancel" }).click();

  await card.getByRole("button", { name: "delete" }).click();

  const confirm = page.getByRole("alertdialog");

  await expect(confirm.getByText(`Delete ${name}?`)).toBeVisible();
  await confirm.getByRole("button", { name: "Delete channel" }).click();

  await expect(card).toHaveCount(0);
});
