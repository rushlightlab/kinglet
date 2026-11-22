import { expect, test } from "@playwright/test";
import { DEFAULT_PROJECT_NAME } from "./support/data";
import { readSeed } from "./support/state";

test("an MCP key is shown once with the pinned client config and can be revoked", async ({
  page,
}) => {
  const seed = readSeed();
  const name = `e2e mcp ${Date.now()}`;

  await page.goto("/settings");

  const projectRow = page.getByRole("row").filter({ hasText: DEFAULT_PROJECT_NAME });

  await projectRow.getByRole("link", { name: "manage" }).click();
  await expect(page.getByRole("heading", { name: `${DEFAULT_PROJECT_NAME}.` })).toBeVisible();
  await expect(page.getByText("MCP keys", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "new MCP key" }).click();

  const createDialog = page.getByRole("dialog");

  await createDialog.getByLabel("name").fill(name);
  await createDialog.getByRole("button", { name: "Create MCP key" }).click();

  const secretDialog = page.getByRole("dialog");

  await expect(secretDialog.getByText(/Copy this MCP key now/)).toBeVisible();

  const secret = await secretDialog.locator("code").filter({ hasText: "km_" }).first().innerText();

  expect(secret).toMatch(/^km_[A-Za-z0-9_-]+$/);

  const config = await secretDialog.locator("pre").innerText();

  expect(config).toContain('"@kinglet/mcp@0.4.0"');
  expect(config).toContain(`"KINGLET_URL": "${seed.baseURL}"`);
  expect(config).toContain(`"KINGLET_MCP_KEY": "${secret}"`);

  await secretDialog.getByRole("button", { name: "done" }).click();

  // The one-time secret must not survive in the page or a reload.
  await expect(page.locator("body")).not.toContainText(secret);
  await page.reload();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(secret);

  const keyRow = page.getByRole("row").filter({ hasText: name });

  await keyRow.getByRole("button", { name: `Actions for ${name}` }).click();
  await page.getByRole("menuitem", { name: "Revoke key" }).click();

  const confirm = page.getByRole("alertdialog");

  await expect(confirm.getByText(`Revoke ${name}?`)).toBeVisible();
  await confirm.getByRole("button", { name: "Revoke key" }).click();

  await expect(page.getByRole("row").filter({ hasText: name })).toHaveCount(0);
});
