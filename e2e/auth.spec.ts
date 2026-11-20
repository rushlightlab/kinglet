import { expect, test } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD } from "./support/data";
import { signInThroughUi } from "./support/ui";

// This test owns its sessions; it must not sign out the shared admin state.
test.use({ storageState: { cookies: [], origins: [] } });

test("an administrator can sign out and sign back in", async ({ page }) => {
  await signInThroughUi(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await expect(page.getByRole("link", { name: "Kinglet home" })).toBeVisible();

  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();

  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(page.getByLabel("email")).toHaveValue("");

  await page.getByLabel("email").fill(ADMIN_EMAIL);
  await page.getByLabel("password", { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("link", { name: "Kinglet home" })).toBeVisible();
});
