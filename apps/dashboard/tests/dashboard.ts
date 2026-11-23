import { defineNetworkFixture, type NetworkFixture } from "@msw/playwright";
import {
  chromium,
  type BrowserContext,
  type BrowserContextOptions,
  type Locator,
  type Page,
  type Route,
} from "playwright";
import { expect, inject, test as base } from "vite-plus/test";

import { DASHBOARD_BASE } from "../../hub/src/dashboard.ts";
import { createHub } from "./hub.ts";
import { NO_JOBS, NOW, signedIn } from "./records.ts";

export { expect as expectBrowser } from "playwright/test";

/** What a test may set of the browser it opens the dashboard in. */
export type BrowserOptions = Pick<
  BrowserContextOptions,
  "viewport" | "timezoneId" | "locale" | "hasTouch" | "isMobile" | "permissions"
>;

/**
 * Opens the dashboard's page at `path`, such as `"runners"`, in a new tab: the first with
 * `options`, every later one, a second tab, in the same browser.
 */
export type Open = (path: string, options?: BrowserOptions) => Promise<Page>;

/**
 * The test for a dashboard page, driven in Chromium against the stand-in for the hub. `hub` is
 * arranged before or between steps. It answers the shell's own reads until a test arranges them: a
 * session of an owner of the Organization, no Runners and no unfinished jobs. Any other call it has
 * no answer for, and any request outside the contract, Better Auth's routes and the build, fails the
 * test, which names them; a request the hub's API handler refuses before the procedure runs, such as
 * one whose input the contract refuses, needs no answer, as the hub's refusal answers it. A call whose answer is lost is arranged with `drops`, and a browser gone
 * offline with `setOffline`. `open` opens a page. Its clock stands still at `NOW` until a test
 * moves it, so no poll or deadline passes unless the test makes it.
 */
export const test = base
  // oxlint-disable-next-line no-empty-pattern -- Vitest reads a fixture's dependencies from its first parameter, which must be a destructuring pattern; this one has none.
  .extend("browser", { scope: "worker" }, async ({}, { onCleanup }) => {
    const browser = await chromium.launch();
    onCleanup(() => browser.close());
    return browser;
  })
  // The stand-in and the network serving it, which the `open` fixture serves the page through.
  .extend("standIn", async () => {
    const standIn = createHub(inject("dashboardOrigin"));
    standIn.hub.session.answers(signedIn("owner"));
    standIn.hub.runners.list.answers([]);
    standIn.hub.jobs.counts.answers(NO_JOBS);
    return standIn;
  })
  .extend("hub", async ({ standIn }) => standIn.hub)
  .extend("open", async ({ browser, standIn }, { onCleanup }): Promise<Open> => {
    const { network } = standIn;
    const origin = inject("dashboardOrigin");
    const files = new Set(inject("dashboardFiles"));
    const strays: string[] = [];
    let context: BrowserContext | undefined;
    let msw: NetworkFixture | undefined;
    let over = false;

    // In this order: a page still reading once the handlers go would send its reads past them.
    onCleanup(async () => {
      over = true;
      network.releaseAll();
      if (context) {
        for (const page of context.pages()) await page.close();
        await msw?.disable();
        await context.close();
      }
      const unarranged = [...network.unarranged, ...strays];
      if (unarranged.length > 0) {
        throw new Error(`Requests the test arranged no answer for:\n${unarranged.join("\n")}`);
      }
    });

    // What MSW passes on: the build's navigations and files, which the preview server serves.
    async function serveBuild(route: Route) {
      const request = route.request();
      const url = new URL(request.url());
      const isNavigation = request.isNavigationRequest() && url.pathname.startsWith(DASHBOARD_BASE);
      if (
        url.origin === origin &&
        request.method() === "GET" &&
        (isNavigation || files.has(url.pathname))
      ) {
        return route.continue();
      }
      if (!over) strays.push(`${request.method()} ${url.href}`);
      return route.abort();
    }

    async function start(options: BrowserOptions = {}) {
      const started = await browser.newContext({
        baseURL: origin,
        serviceWorkers: "block",
        locale: "en-US",
        timezoneId: "UTC",
        ...options,
      });
      context = started;
      // Within the test's own timeout, so a step that cannot happen names its locator.
      started.setDefaultTimeout(5_000);
      // Before MSW's, which Playwright then asks first.
      await started.route("**/*", serveBuild);
      const fixture = defineNetworkFixture({ context: started, handlers: [...network.handlers] });
      msw = fixture;
      await fixture.enable();
      // MSW builds the request its handlers read from Playwright's `allHeaders()`. For a routed request
      // Playwright takes those from where Chromium paused it, before the network stack adds the
      // Content-Length the browser sends with a body, which the hub's upload requires: given back from
      // the body, ahead of MSW, which Playwright asks after this route.
      await started.route("**/*", (route) => {
        const request = route.request();
        const body = request.postDataBuffer();
        return route.fallback(
          body ? { headers: { ...request.headers(), "content-length": String(body.length) } } : {},
        );
      });
      await started.clock.install({ time: NOW });
      await started.clock.pauseAt(NOW);
      return started;
    }

    return async (path, options) => {
      if (context && options) throw new Error("A second tab shares the first one's browser");
      const page = await (context ?? (await start(options))).newPage();
      await page.goto(DASHBOARD_BASE + path);
      return page;
    };
  });

/** What a page says when it could not confirm a write the hub may have made. */
export const UNCERTAIN =
  "The dashboard could not confirm this was done. Check before trying again.";

/**
 * Takes the browser of `page` offline, or back online with `offline` false. The stand-in answers
 * inside the browser, ahead of its network, so going offline alone would not stop a request reaching
 * it: while offline, every request fails here, as the network fails it.
 */
export async function setOffline(page: Page, offline: boolean) {
  const context = page.context();
  if (offline) {
    await context.route("**/*", disconnected);
    await context.setOffline(true);
  } else {
    await context.unroute("**/*", disconnected);
    await context.setOffline(false);
  }
}

const disconnected = (route: Route) => route.abort("internetdisconnected");

/**
 * Moves the page's clock `step` milliseconds at a time until `reached` holds. One jump does not do
 * where the page sets its next timer only once an answer from the hub arrives, in real time: a jump
 * past that timer fires only those set before it. Query sets each retry once the previous try has
 * failed, and the Effect fibers of a send yield to the browser through a timer between uploads.
 */
export async function runClockUntil(
  page: Page,
  step: number,
  reached: () => boolean | Promise<boolean>,
) {
  await expect
    .poll(
      async () => {
        await page.clock.runFor(step);
        return reached();
      },
      // As long as a step of the page may take, which a failure then names.
      { timeout: 5_000 },
    )
    .toBe(true);
}

/**
 * The words that describe `control` when focus arrives on it, captured then, before later updates
 * to the page can change them.
 */
export function descriptionOnFocus(control: Locator) {
  return control.evaluateHandle((element) => {
    const words: string[] = [];
    element.addEventListener(
      "focusin",
      () => {
        for (const part of element.ariaDescribedByElements ?? [])
          words.push(part.textContent ?? "");
      },
      { once: true },
    );
    return words;
  });
}

export function liveRegions(page: Page) {
  return page.locator(
    '[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"], output',
  );
}

/**
 * Has the page read again what it shows, as returning to its tab does once that is stale, past
 * Query's `staleTime` of a second. The clock is set forward rather than run, so no timer fires
 * meanwhile: one could change the page under the test, as the one that announces a pending action
 * does.
 */
export async function readAgain(page: Page) {
  await page.clock.setSystemTime((await page.evaluate(() => Date.now())) + 2_000);
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
}
