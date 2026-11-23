import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { ACCOUNT_EMAIL, ACCOUNT_NEW_PASSWORD, ACCOUNT_PASSWORD } from "./support/data";
import { signInThroughUi } from "./support/ui";

// A retry could not sign in after a half-finished password change.
test.describe.configure({ retries: 0 });

test.use({ storageState: { cookies: [], origins: [] } });

async function changePassword(page: Page, current: string, next: string): Promise<void> {
  await page.getByRole("button", { name: "change password" }).click();

  const dialog = page.getByRole("dialog");

  await dialog.getByLabel("current", { exact: true }).fill(current);
  await dialog.getByLabel("new", { exact: true }).fill(next);
  await dialog.getByLabel("confirm", { exact: true }).fill(next);
  await dialog.getByRole("button", { name: "update password" }).click();

  // The dialog only closes after the server accepts the change.
  await expect(dialog).toHaveCount(0);
}

test("an account can change its password and sign in with the new one", async ({ page }) => {
  await signInThroughUi(page, ACCOUNT_EMAIL, ACCOUNT_PASSWORD);
  await expect(page.getByRole("link", { name: "Kinglet home" })).toBeVisible();

  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Account settings" }).click();
  // Account settings are the last settings tab, so the nav shows where you are.
  await expect(page).toHaveURL(/\/settings\?tab=account/);
  await expect(page.getByRole("tab", { name: "my account" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("tabpanel").getByText(ACCOUNT_EMAIL, { exact: true })).toBeVisible();

  let changed = false;

  try {
    await changePassword(page, ACCOUNT_PASSWORD, ACCOUNT_NEW_PASSWORD);
    changed = true;
    await changePassword(page, ACCOUNT_NEW_PASSWORD, ACCOUNT_PASSWORD);
    changed = false;
  } finally {
    if (changed) {
      await changePassword(page, ACCOUNT_NEW_PASSWORD, ACCOUNT_PASSWORD).catch(() => undefined);
    }
  }

  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();

  await page.getByLabel("email").fill(ACCOUNT_EMAIL);
  await page.getByLabel("password", { exact: true }).fill(ACCOUNT_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("link", { name: "Kinglet home" })).toBeVisible();
});
