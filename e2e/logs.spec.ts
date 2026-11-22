import { expect, test } from "@playwright/test";
import {
  DRAWER_ORDER_ID,
  EVENT_CHECKOUT_OK,
  EVENT_DRAWER,
  EVENT_NEEDLE,
  EVENT_OTHER_ERROR,
} from "./support/data";
import { readSeed } from "./support/state";
import { logRow } from "./support/ui";

/**
 * Instrument EventSource from the first document so the test can wait for the
 * real `open` event of /v1/stream instead of guessing with a fixed delay.
 * `/v1/system/events` (the admin feed) deliberately does not set the flag.
 */
const STREAM_READY_INIT = `(() => {
  const NativeEventSource = window.EventSource;
  window.__kingletE2eStreamOpen = false;
  class InstrumentedEventSource extends NativeEventSource {
    constructor(url, options) {
      super(url, options);
      if (String(url).includes("/v1/stream")) {
        this.addEventListener(
          "open",
          () => {
            window.__kingletE2eStreamOpen = true;
          },
          { once: true },
        );
      }
    }
  }
  window.EventSource = InstrumentedEventSource;
})();`;

test("search and filters narrow the log table", async ({ page }) => {
  await page.goto("/");

  await expect(logRow(page, EVENT_NEEDLE)).toBeVisible();
  await expect(logRow(page, EVENT_CHECKOUT_OK)).toBeVisible();

  const filter = page.getByPlaceholder("level:error service:api");

  await filter.fill(`"${EVENT_NEEDLE}"`);
  await filter.press("Enter");

  await expect(logRow(page, EVENT_NEEDLE)).toBeVisible();
  await expect(logRow(page, EVENT_CHECKOUT_OK)).toHaveCount(0);

  await filter.fill("level:error service:checkout");
  await filter.press("Enter");

  await expect(logRow(page, EVENT_NEEDLE)).toBeVisible();
  await expect(logRow(page, EVENT_OTHER_ERROR)).toHaveCount(0);
});

test("the event drawer shows the message, service, and fields", async ({ page }) => {
  await page.goto("/");
  await expect(logRow(page, EVENT_DRAWER)).toBeVisible();

  await logRow(page, EVENT_DRAWER).click();

  const drawer = page.getByRole("complementary");

  await expect(drawer).toBeVisible();
  await expect(drawer.getByText(EVENT_DRAWER)).toBeVisible();
  await expect(drawer.getByText("worker", { exact: true })).toBeVisible();
  await expect(drawer.getByText(DRAWER_ORDER_ID)).toBeVisible();

  await drawer.getByRole("button", { name: "Close" }).click();
  await expect(drawer).toHaveCount(0);
});

test("a field in the drawer filters the table by its value", async ({ page }) => {
  await page.goto("/");
  await expect(logRow(page, EVENT_DRAWER)).toBeVisible();
  await expect(logRow(page, EVENT_NEEDLE)).toBeVisible();

  await logRow(page, EVENT_DRAWER).click();
  await page
    .getByRole("complementary")
    .getByRole("button", { name: `Filter by field.orderId:${DRAWER_ORDER_ID}` })
    .click();

  await expect(page.getByPlaceholder("level:error service:api")).toHaveValue(
    `field.orderId:${DRAWER_ORDER_ID}`,
  );
  await expect(logRow(page, EVENT_DRAWER)).toBeVisible();
  await expect(logRow(page, EVENT_NEEDLE)).toHaveCount(0);
});

test("field comparisons and the text scope switch narrow the table", async ({ page }) => {
  await page.goto("/");
  await expect(logRow(page, EVENT_DRAWER)).toBeVisible();

  const filter = page.getByPlaceholder("level:error service:api");

  await filter.fill("field.status>=500");
  await filter.press("Enter");
  await expect(logRow(page, EVENT_DRAWER)).toBeVisible();
  await expect(logRow(page, EVENT_NEEDLE)).toHaveCount(0);

  // "drawer payload" is only in the event's fields, not its message.
  await filter.fill('"drawer payload"');
  await filter.press("Enter");
  await expect(logRow(page, EVENT_DRAWER)).toHaveCount(0);

  await page.getByRole("radio", { name: "fields" }).click();
  await expect(filter).toHaveValue('"drawer payload" in:fields');
  await expect(logRow(page, EVENT_DRAWER)).toBeVisible();
  await expect(logRow(page, EVENT_NEEDLE)).toHaveCount(0);
});

test("autocomplete completes a field key and then one of its values", async ({ page }) => {
  await page.goto("/");
  await expect(logRow(page, EVENT_DRAWER)).toBeVisible();

  const filter = page.getByRole("combobox", { name: "Search logs" });

  await filter.click();
  await filter.pressSequentially("field.ord");
  await expect(page.getByRole("option", { name: /field\.orderId/ })).toBeVisible();
  await filter.press("Tab");
  await expect(filter).toHaveValue("field.orderId:");

  await page.getByRole("option", { name: new RegExp(DRAWER_ORDER_ID) }).click();
  await expect(filter).toHaveValue(`field.orderId:${DRAWER_ORDER_ID} `);

  await filter.press("Enter");
  await expect(logRow(page, EVENT_DRAWER)).toBeVisible();
  await expect(logRow(page, EVENT_NEEDLE)).toHaveCount(0);
});

test("the search clears with its button or Escape", async ({ page }) => {
  await page.goto("/");
  await expect(logRow(page, EVENT_CHECKOUT_OK)).toBeVisible();

  const filter = page.getByRole("combobox", { name: "Search logs" });

  await filter.fill(`"${EVENT_NEEDLE}"`);
  await filter.press("Enter");
  await expect(logRow(page, EVENT_CHECKOUT_OK)).toHaveCount(0);

  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(filter).toHaveValue("");
  await expect(logRow(page, EVENT_CHECKOUT_OK)).toBeVisible();

  await filter.fill(`"${EVENT_NEEDLE}"`);
  await filter.press("Enter");
  await expect(logRow(page, EVENT_CHECKOUT_OK)).toHaveCount(0);
  await filter.press("Escape");
  await expect(filter).toHaveValue("");
  await expect(logRow(page, EVENT_CHECKOUT_OK)).toBeVisible();
});

test("a saved search can be applied and removed from its chip", async ({ page }) => {
  await page.goto("/");

  const filter = page.getByRole("combobox", { name: "Search logs" });

  await filter.fill("level:error");
  await filter.press("Enter");
  await page.getByRole("button", { name: "save" }).click();

  const remove = page.getByRole("button", { name: "Remove saved search level:error" });

  await expect(remove).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).click();
  await page.getByRole("button", { name: "level:error", exact: true }).click();
  await expect(filter).toHaveValue("level:error");

  await remove.click();
  await expect(remove).toHaveCount(0);
});

test("the live tail renders a newly ingested event", async ({ page }) => {
  const seed = readSeed();

  await page.addInitScript(STREAM_READY_INIT);
  await page.goto("/");
  await expect(page.getByRole("switch", { name: "live" })).toHaveAttribute("aria-checked", "true");
  await expect(logRow(page, EVENT_NEEDLE)).toBeVisible();
  await page.waitForFunction("window.__kingletE2eStreamOpen === true");

  const message = `e2e live gamma ${seed.runId} ${Date.now()}`;

  const response = await page.request.post("/v1/events", {
    headers: { authorization: `Bearer ${seed.apiKey}` },
    data: { message, level: "info", service: "live-e2e", env: "e2e" },
  });

  expect(response.ok()).toBeTruthy();
  await expect(logRow(page, message)).toBeVisible({ timeout: 15_000 });
});
