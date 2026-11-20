import type { Locator, Page } from "@playwright/test";

/** Cards expose a stable `data-slot` attribute from the shadcn primitive. */
export function cardWithText(page: Page, text: string): Locator {
  return page.locator('[data-slot="card"]').filter({ hasText: text });
}

/** Log rows are buttons named after the event message. */
export function logRow(page: Page, message: string): Locator {
  return page.getByRole("button", { name: new RegExp(`Open event: ${message}`) });
}

export async function signInThroughUi(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/");
  await page.getByLabel("email").fill(email);
  await page.getByLabel("password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

export async function openSettingsTab(page: Page, tab: string): Promise<void> {
  await page.goto("/settings");
  await page.getByRole("tab", { name: tab }).click();
}
