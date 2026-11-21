import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { ACCOUNT_EMAIL, ACCOUNT_NEW_PASSWORD, ACCOUNT_PASSWORD } from "./support/data";
import { signInThroughUi } from "./support/ui";

// A retry could not sign in after a half-finished password change.
test.describe.configure({ retries: 0 });

test.use({ storageState: { cookies: [], origins: [] } });

async function changePassword(page: Page, current: string, next: string): Promise<void> {
  await page.getByLabel("current", { exact: true }).fill(current);
  await page.getByLabel("new", { exact: true }).fill(next);
  await page.getByLabel("confirm", { exact: true }).fill(next);
  await page.getByRole("button", { name: "update password" }).click();

  // The form only clears its fields after the server accepts the change.
  await expect(page.getByLabel("current", { exact: true })).toHaveValue("");
}

test("an account can change its password and sign in with the new one", async ({ page }) => {
  await signInThroughUi(page, ACCOUNT_EMAIL, ACCOUNT_PASSWORD);
  await expect(page.getByRole("link", { name: "Kinglet home" })).toBeVisible();

  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Account settings" }).click();
  await expect(page.getByRole("heading", { name: "Your account." })).toBeVisible();

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
