import { expect, test } from "@playwright/test";
import { openSettingsTab } from "./support/ui";

interface BackupStatusPayload {
  status: {
    configured: boolean;
    setupMissing: string[];
  };
}

test("backups show the unconfigured setup state", async ({ page }) => {
  const response = await page.request.get("/v1/backups/status");

  expect(response.ok()).toBeTruthy();

  const payload: BackupStatusPayload = await response.json();

  expect(payload.status.configured).toBe(false);
  expect(payload.status.setupMissing).toContain("KINGLET_BACKUP_S3_BUCKET");

  await openSettingsTab(page, "backups");

  await expect(page.getByText("Connect a bucket", { exact: true })).toBeVisible();
  await expect(page.getByText("Snapshots stay off until the S3 settings")).toBeVisible();
  await expect(page.getByText("missing right now")).toBeVisible();
  await expect(page.getByText("KINGLET_BACKUP_S3_BUCKET", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Connect a bucket", { exact: true })).toHaveCount(1);
});
