import { expect, test } from "@playwright/test";
import { ADMIN_EMAIL } from "./support/data";
import { openSettingsTab, rowAction, tableRow } from "./support/ui";

test("an admin adds a user from the dialog and finds them with the table search", async ({
  page,
}) => {
  const email = `e2e-user-${Date.now()}@example.com`;

  await openSettingsTab(page, "users");
  await page.getByRole("button", { name: "add user" }).click();

  const dialog = page.getByRole("dialog");

  await dialog.getByLabel("email").fill(email);
  await dialog.getByLabel("name").fill("Casey Example");
  await dialog.getByRole("button", { name: "Create user" }).click();

  await expect(dialog).toHaveCount(0);
  // A blank password is generated and shown once, outside the dialog.
  await expect(page.getByText(`Password for ${email} — copy it now`)).toBeVisible();

  await page.getByRole("searchbox", { name: "Search users" }).fill("casey example");
  await expect(tableRow(page, email)).toBeVisible();
  await expect(page.getByRole("row")).toHaveCount(2);
});

test("the old account address opens the my account tab", async ({ page }) => {
  await page.goto("/account");

  await expect(page).toHaveURL(/\/settings\?tab=account/);
  await expect(page.getByRole("button", { name: "change password" })).toBeVisible();
});

test("project settings split keys, members, and general into tabs", async ({ page }) => {
  await openSettingsTab(page, "projects");
  await page.getByRole("link", { name: "manage" }).first().click();

  await expect(page.getByRole("tab", { name: "keys" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Application keys", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: "general" }).click();
  await expect(page).toHaveURL(/tab=general/);
  await expect(page.getByText("Clear logs", { exact: true })).toBeVisible();
  await expect(page.getByText("Application keys", { exact: true })).toHaveCount(0);
});

test("an admin edits a user's name and role, but not their own role", async ({ page }) => {
  const email = `e2e-edit-${Date.now()}@example.com`;

  await openSettingsTab(page, "users");
  await page.getByRole("button", { name: "add user" }).click();

  const addDialog = page.getByRole("dialog");

  await addDialog.getByLabel("email").fill(email);
  await addDialog.getByLabel("name").fill("Before Name");
  await addDialog.getByRole("button", { name: "Create user" }).click();
  await expect(addDialog).toHaveCount(0);

  await page.getByRole("searchbox", { name: "Search users" }).fill(email);

  const row = tableRow(page, email);

  await rowAction(row, "Edit user");

  const editDialog = page.getByRole("dialog");

  await editDialog.getByLabel("name").fill("After Name");
  await editDialog.getByLabel("role").click();
  await page.getByRole("option", { name: /^admin/ }).click();
  await expect(editDialog.getByText(/Admins see every project/)).toBeVisible();
  await editDialog.getByRole("button", { name: "Save changes" }).click();

  await expect(editDialog).toHaveCount(0);
  await expect(row).toContainText("After Name");
  await expect(row.getByText("admin", { exact: true })).toBeVisible();

  // Your own row opens the editor too, with the role locked.
  await page.getByRole("searchbox", { name: "Search users" }).fill(ADMIN_EMAIL);
  await rowAction(tableRow(page, ADMIN_EMAIL), "Edit user");
  await expect(page.getByRole("dialog").getByText("You can't change your own role.")).toBeVisible();
  await expect(page.getByRole("dialog").getByLabel("role")).toBeDisabled();
});
