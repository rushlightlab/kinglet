import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import { EVENT_CHECKOUT_OK, EVENT_NEEDLE } from "./support/data";
import { logRow } from "./support/ui";

/**
 * Holds matching API requests until `release()` is called, so a test can look
 * at the page while a request is in flight without guessing at timings.
 */
async function holdRequests(
  page: Page,
  matches: (url: URL) => boolean,
): Promise<{ release: () => void; held: () => number }> {
  let release: (() => void) | undefined;
  let held = 0;

  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });

  await page.route(matches, async (route: Route) => {
    held += 1;
    await opened;
    await route.continue();
  });

  return { release: () => release?.(), held: () => held };
}

const isEventsOrHistogram = (url: URL): boolean =>
  url.pathname === "/v1/events" || url.pathname === "/v1/histogram";

test("the log view shows placeholders, not an empty state, while it first loads", async ({
  page,
}) => {
  const held = await holdRequests(page, isEventsOrHistogram);

  await page.goto("/");

  await expect(page.getByRole("status").filter({ hasText: "Loading events…" })).toBeAttached();
  await expect(page.getByText("searching…")).toBeVisible();
  await expect(page.getByText("No events match.")).toHaveCount(0);

  held.release();

  await expect(logRow(page, EVENT_NEEDLE)).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Loading events…" })).toHaveCount(0);
});

test("a slow earlier search does not replace a newer one", async ({ page }) => {
  await page.goto("/");
  await expect(logRow(page, EVENT_NEEDLE)).toBeVisible();

  const staleQuery = `"${EVENT_CHECKOUT_OK}"`;

  const held = await holdRequests(
    page,
    (url) => isEventsOrHistogram(url) && url.searchParams.get("q") === staleQuery,
  );

  const filter = page.getByPlaceholder("level:error service:api");

  await filter.fill(staleQuery);
  await filter.press("Enter");
  // Both the events and histogram requests for the stale search are in flight.
  await expect.poll(() => held.held()).toBe(2);
  await filter.fill(`"${EVENT_NEEDLE}"`);
  await filter.press("Enter");

  await expect(logRow(page, EVENT_NEEDLE)).toBeVisible();
  await expect(logRow(page, EVENT_CHECKOUT_OK)).toHaveCount(0);

  const staleResponses = ["/v1/events", "/v1/histogram"].map((path) =>
    page.waitForResponse((res) => {
      const url = new URL(res.url());

      return url.pathname === path && url.searchParams.get("q") === staleQuery;
    }),
  );

  held.release();

  // Wait until the page has both stale bodies, then two frames for React to
  // apply them if it were going to.
  for (const response of await Promise.all(staleResponses)) await response.finished();
  await page.evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");

  await expect(logRow(page, EVENT_NEEDLE)).toBeVisible();
  await expect(logRow(page, EVENT_CHECKOUT_OK)).toHaveCount(0);
});

test("the monitors page says it is loading instead of 'No monitors yet'", async ({ page }) => {
  const held = await holdRequests(page, (url) => url.pathname === "/v1/monitors");

  await page.goto("/monitors");

  await expect(page.getByText("loading monitors…", { exact: true })).toBeVisible();
  await expect(page.getByText("No monitors yet.")).toHaveCount(0);

  held.release();

  await expect(page.getByText("loading monitors…", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/^\d+ monitors?$/)).toBeVisible();
});
