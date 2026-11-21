import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD } from "./support/data";
import { ADMIN_STATE_PATH } from "./support/state";
import { signInThroughUi } from "./support/ui";

test("sign in as the seeded administrator", async ({ page }) => {
  await signInThroughUi(page, ADMIN_EMAIL, ADMIN_PASSWORD);

  await expect(page.getByRole("link", { name: "Kinglet home" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Current project" })).toBeVisible();

  await page.context().storageState({ path: ADMIN_STATE_PATH });
  fs.chmodSync(ADMIN_STATE_PATH, 0o600);
});
