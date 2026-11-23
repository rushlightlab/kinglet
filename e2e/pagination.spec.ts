import { expect, test } from "@playwright/test";
import { DEFAULT_PROJECT_NAME } from "./support/data";
import { readSeed } from "./support/state";
import { tableRow } from "./support/ui";

test("a table pages on the server with 5, 20, 50, or 100 rows", async ({ page }) => {
  const seed = readSeed();
  const prefix = `e2e paged ${Date.now()}`;

  // Seven monitors that share a prefix, so a search narrows to exactly them.
  for (let i = 1; i <= 7; i++) {
    const response = await page.request.post(`/v1/monitors?project=${seed.projects.defaultId}`, {
      headers: { "X-Kinglet-Request": "1" },
      data: { name: `${prefix} ${i}`, query: "e2e paging", kind: "match", enabled: false },
    });

    expect(response.ok()).toBeTruthy();
  }

  await page.goto("/monitors");
  await page.getByRole("searchbox", { name: "Search monitors" }).fill(prefix);

  // Tables start at 5 rows.
  await expect(page.getByText("1–5 of 7 monitors")).toBeVisible();
  await expect(tableRow(page, prefix)).toHaveCount(5);

  await page.getByRole("button", { name: "Next page" }).first().click();
  await expect(page.getByText("6–7 of 7 monitors")).toBeVisible();
  await expect(tableRow(page, prefix)).toHaveCount(2);

  await page.getByLabel("rows").first().click();
  await page.getByRole("option", { name: "20", exact: true }).click();
  await expect(page.getByText("1–7 of 7 monitors")).toBeVisible();

  // The chosen size is remembered for the table.
  await page.reload();
  await page.getByRole("searchbox", { name: "Search monitors" }).fill(prefix);
  await expect(page.getByText("1–7 of 7 monitors")).toBeVisible();
});

test("the cog beside the project picker opens project settings and stays lit there", async ({
  page,
}) => {
  await page.goto("/");

  const cog = page.getByRole("link", { name: `Settings for ${DEFAULT_PROJECT_NAME}` });
  const picker = page.getByRole("combobox", { name: "Current project" });

  await expect(cog).not.toHaveAttribute("aria-current", "page");
  await expect(cog).not.toHaveCSS("color", "rgb(251, 191, 36)");
  await expect(picker).not.toHaveCSS("color", "rgb(251, 191, 36)");
  await cog.click();

  await expect(page.getByRole("heading", { name: `${DEFAULT_PROJECT_NAME}.` })).toBeVisible();
  await expect(cog).toHaveAttribute("aria-current", "page");
  // Off the cog, so a hover color cannot stand in for the lit state.
  await page.mouse.move(0, 400);
  await expect(cog).toHaveCSS("color", "rgb(251, 191, 36)");
  // The picker lights up with the cog, so the pair reads as one control.
  await expect(picker).toHaveCSS("color", "rgb(251, 191, 36)");
});
