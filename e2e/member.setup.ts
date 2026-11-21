import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { MEMBER_EMAIL, MEMBER_PASSWORD } from "./support/data";
import { MEMBER_STATE_PATH } from "./support/state";
import { signInThroughUi } from "./support/ui";

test("sign in as the seeded member", async ({ page }) => {
  await signInThroughUi(page, MEMBER_EMAIL, MEMBER_PASSWORD);

  await expect(page.getByRole("link", { name: "Kinglet home" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Current project" })).toBeVisible();

  await page.context().storageState({ path: MEMBER_STATE_PATH });
  fs.chmodSync(MEMBER_STATE_PATH, 0o600);
});
