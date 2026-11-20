import { expect, test } from "@playwright/test";
import { openSettingsTab } from "./support/ui";

test("backups show the unconfigured setup state", async ({ page }) => {
  await openSettingsTab(page, "backups");

  await expect(page.getByText("Connect a bucket", { exact: true })).toBeVisible();
  await expect(page.getByText("Snapshots stay off until the S3 settings")).toBeVisible();
  await expect(page.getByText("missing right now")).toBeVisible();
  await expect(page.getByText("KINGLET_BACKUP_S3_BUCKET", { exact: true }).first()).toBeVisible();

  // The configured surface must not flash before the status arrives.
  await expect(page.getByText("Backup status", { exact: true })).toHaveCount(0);
});
