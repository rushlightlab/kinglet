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
  // Each required variable is listed once, marked missing until the server has it.
  const bucketVar = page.getByRole("listitem").filter({ hasText: "KINGLET_BACKUP_S3_BUCKET" });

  await expect(bucketVar).toHaveCount(1);
  await expect(bucketVar).toContainText("missing");
  await expect(page.getByText("Connect a bucket", { exact: true })).toHaveCount(1);
});
