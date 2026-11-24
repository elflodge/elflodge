import { render } from "@solidjs/web";
import { createBrowserHistory, RouterProvider } from "@tanstack/solid-router";
import { asError } from "contract";
import { expect, test as base, vi } from "vite-plus/test";
import { locators, page, userEvent, type Locator } from "vite-plus/test/browser/context";

import { DASHBOARD_BASE } from "../../../hub/src/dashboard.ts";
import { getRouter } from "../../src/router.tsx";
import type { Dropped } from "../../vite.config.ts";
import { createHub } from "../hub.ts";
import { NO_JOBS, NOW, signedIn } from "../records.ts";
import { respondWith } from "./fetch.ts";

declare module "vite-plus/test/browser" {
  interface BrowserCommands {
    /** Taps `locator`'s element with Playwright, in a browser with touch. */
    tap(locator: Locator): Promise<void>;
    /**
     * Drops `entries` on `locator`'s element through the browser's own hit test, and returns the
     * folder they were written to, for `removeDropped`.
     */
    drop(locator: Locator, entries: Dropped): Promise<string>;
    removeDropped(folder: string): Promise<void>;
  }
}

declare module "vite-plus/test/browser/context" {
  interface LocatorSelectors {
    /** The elements `css`, a CSS selector, matches, as Playwright's `locator` finds them. */
    getByCSS(css: string): Locator;
  }
}

// As Vitest's documentation of `locators.extend` shows it.
locators.extend({
  getByCSS(css: string) {
    return `css=${css}`;
  },
});

/** What a test may set of the page it opens the dashboard in. */
export interface PageOptions {
  viewport?: { width: number; height: number };
}

/** Mounts the dashboard at `path`, such as `"runners"`, in the test's own document. */
export type Open = (path: string, options?: PageOptions) => Promise<typeof page>;

/**
 * The browser project's viewport, which Vitest sets once for each file: `open` sets it again, as a
 * test may have narrowed it.
 */
const VIEWPORT = { width: 1280, height: 720 };

/**
 * The test for a dashboard page, mounted in the document the test runs in, against the stand-in
 * for the hub, which answers the page's `fetch` in the same document. These fail the test, which
 * names them: a call it has no answer for; a `fetch` the stand-in does not answer, or a WebSocket;
 * an arranged answer that throws, other than a procedure's declared refusal, or that the contract
 * refuses; a request sent after the test. `open` mounts the app at an address of the dashboard.
 * Its timers and clock start at `NOW` and move when a test moves them, and as Vitest moves them
 * while an action or a retrying assertion waits, by as much real time as that wait takes: a test
 * cannot hold the clock to the millisecond, so it asserts what a member would notice instead.
 */
export const test = base
  .extend("standIn", async () => {
    const standIn = createHub(location.origin);
    standIn.hub.session.answers(signedIn("owner"));
    standIn.hub.runners.list.answers([]);
    standIn.hub.jobs.counts.answers(NO_JOBS);
    return standIn;
  })
  .extend("hub", async ({ standIn }) => standIn.hub)
  .extend("open", async ({ standIn }, { onCleanup }): Promise<Open> => {
    const { network } = standIn;
    const strays: string[] = [];
    const failures: string[] = [];
    sent = [];
    responseWaiters.clear();
    let mounted: { dispose(): void; destroy(): void } | undefined;

    onCleanup(async () => {
      mountAgainHere = undefined;
      // Back online while the app still listens: Query's `onlineManager` hears the browser's events
      // only while something subscribes to it, and keeps what it last heard for the next test.
      setOffline(false);
      mounted?.dispose();
      mounted?.destroy();
      vi.unstubAllGlobals();
      vi.useRealTimers();
      // The tests of a file share the document and its `fetch`, so work a test leaves running, such
      // as the reads of a navigation it started, would reach the next test's stand-in: it gets a task
      // to reach this one's. Calls the test still holds stay unanswered, so nothing waiting on them
      // goes on.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const unarranged = [...network.unarranged, ...strays];
      const failed = [...network.failures, ...failures];
      // From here a request is late: the network fails it, and it fails this test.
      const late: string[] = [];
      respondWith(async (input, init) => {
        const request = new Request(input, init);
        late.push(`${request.method} ${request.url}`);
        throw new TypeError("Failed to fetch");
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      respondWith(undefined);
      const problems = [
        ...(unarranged.length > 0
          ? [`Requests the test arranged no answer for:\n${unarranged.join("\n")}`]
          : []),
        ...(failed.length > 0
          ? [`Requests the stand-in failed to answer:\n${failed.join("\n")}`]
          : []),
        ...(late.length > 0 ? [`Requests sent after the test ended:\n${late.join("\n")}`] : []),
      ];
      if (problems.length > 0) throw new Error(problems.join("\n"));
    });

    // Every fetch goes to the stand-in. One it does not answer fails the test as a stray, and one
    // whose answer throws out of it fails the test with the error; each fails in the page as the
    // network fails a request. A request the page aborts, as a deadline does, stops waiting.
    respondWith(async (input, init) => {
      const request = new Request(input, init);
      const { signal } = request;
      // The browser's network stack adds Content-Length from the body, which the hub's upload reads;
      // a Request built in the page drops it, but a plain Headers holds it.
      if (request.body) {
        const headers = new Headers(request.headers);
        headers.set("content-length", String((await request.clone().arrayBuffer()).byteLength));
        Object.defineProperty(request, "headers", { value: headers });
      }
      signal.throwIfAborted();
      if (offline) throw new TypeError("Failed to fetch");
      const described = `${request.method} ${request.url}`;
      sent.push(request.clone());
      let response: Response | undefined;
      try {
        response = await untilAborted(network.handle(request), signal);
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        failures.push(`${described}: ${asError(error).message}`);
        throw new TypeError("Failed to fetch", { cause: error });
      }
      if (!response) {
        strays.push(described);
        throw new TypeError("Failed to fetch");
      }
      if (response.type === "error") throw new TypeError("Failed to fetch");
      for (const waiter of responseWaiters) {
        if (!waiter.match(request)) continue;
        responseWaiters.delete(waiter);
        waiter.resolve(response.clone());
      }
      return response;
    });
    // The stand-in serves none.
    vi.stubGlobal(
      "WebSocket",
      new Proxy(WebSocket, {
        construct(_, [url]: [string | URL]) {
          strays.push(`WebSocket ${String(url)}`);
          throw new DOMException("The test serves no WebSocket", "SecurityError");
        },
      }),
    );

    return async (path, options = {}) => {
      if (mounted) throw new Error("A test opens one page");
      const viewport = options.viewport ?? VIEWPORT;
      await page.viewport(viewport.width, viewport.height);
      // Every timer and clock of the page, as Vitest fakes them by default.
      vi.useFakeTimers({ now: NOW });
      mounted = mount(DASHBOARD_BASE + path);
      mountAgainHere = (address) => {
        mounted?.dispose();
        mounted?.destroy();
        mounted = mount(address);
      };
      return page;
    };
  });

/**
 * Mounts the app at `address` with a router and a Query client of its own, as Start's client does on
 * loading a document: at the base the hub serves it under, into the body, as the app's document
 * renders it, where a dialog makes what is beside it inert.
 */
function mount(address: string) {
  history.replaceState(null, "", address);
  const router = getRouter();
  router.update({ ...router.options, basepath: DASHBOARD_BASE, history: createBrowserHistory() });
  const dispose = render(() => <RouterProvider router={router} />, document.body);
  return {
    dispose,
    destroy: () => router.history.destroy(),
  };
}

let offline = false;

/**
 * Takes the page offline, or back online with `next` false, as the browser tells a page its network
 * went or came back: `navigator.onLine` says so, and `window` hears `offline` or `online`, the
 * events TanStack Query's `onlineManager` follows. While offline, every request fails here, as the
 * network fails it. Whether the browser itself tells the page, when its network goes, is not tested.
 */
export function setOffline(next: boolean) {
  if (next === offline) return;
  offline = next;
  if (offline) Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
  else Reflect.deleteProperty(navigator, "onLine");
  window.dispatchEvent(new Event(offline ? "offline" : "online"));
}

let mountAgainHere: ((address: string) => void) | undefined;

/**
 * Mounts the app again at `path`, by default the address it shows, with a new router and Query
 * client, which is what of a reload the document keeps for a test: modules, and the state they hold,
 * stay as they were.
 */
export function mountAgain(path?: string) {
  if (!mountAgainHere) throw new Error("The page is not open");
  mountAgainHere(path === undefined ? location.pathname + location.search : DASHBOARD_BASE + path);
}

/** Runs the page's clock `ms` milliseconds forward, firing each timer due on the way. */
export async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

/**
 * Where the page stands in its own history, which a push moves on and a replace leaves: `history`'s
 * `length` counts the whole tab's, which the frames of other tests share, and which a push after a
 * Back cuts short.
 */
export function historyIndex() {
  const entry = navigation.currentEntry;
  if (!entry) throw new Error("The page has no current history entry");
  return entry.index;
}

/** Runs the page's clock forward to `time`, firing each timer due on the way. */
export async function advanceTo(time: number) {
  const ms = time - Date.now();
  if (ms < 0) throw new Error(`The clock is already ${-ms} ms past the time to advance to`);
  await advance(ms);
}

const responseWaiters = new Set<{
  match: (request: Request) => boolean;
  resolve: (response: Response) => void;
}>();

/** The answer to the first request `match` accepts from now on, once the stand-in gives it. */
export function waitForResponse(match: (request: Request) => boolean) {
  return new Promise<Response>((resolve) => responseWaiters.add({ match, resolve }));
}

let sent: Request[] = [];

/** Every request the page sent in this test, in order. */
export function sentRequests(): readonly Request[] {
  return sent;
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** What a page says when it could not confirm a write the hub may have made. */
export const UNCERTAIN =
  "The dashboard could not confirm this was done. Check before trying again.";

/** Moves the clock `step` milliseconds at a time until `reached` holds. */
export async function runClockUntil(step: number, reached: () => boolean | Promise<boolean>) {
  await expect
    .poll(
      async () => {
        await advance(step);
        return reached();
      },
      { timeout: 5_000 },
    )
    .toBe(true);
}

/** Presses the mouse at `x`, `y` of the viewport, on whatever is there, as Playwright's `mouse.click`. */
export async function clickAt(x: number, y: number) {
  const target = document.elementFromPoint(x, y);
  if (!target) throw new Error(`Nothing at ${x}, ${y}`);
  const box = target.getBoundingClientRect();
  await userEvent.click(target, { position: { x: x - box.left, y: y - box.top }, force: true });
}

/** Checks `box`: presses it, and fails unless it is then checked. */
export async function check(box: Locator) {
  await box.click();
  await expect.element(box).toBeChecked();
}

/** Focuses `locator`'s element once there is one, as Playwright's `locator.focus`. */
export async function focus(locator: Locator) {
  (await locator.findElement()).focus();
}

export function liveRegions() {
  return page.getByCSS(
    '[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"], output',
  );
}

/**
 * Has the page read again what it shows, as returning to its tab does once that is stale, past
 * Query's `staleTime` of a second. The clock is set forward rather than run, so no timer fires.
 */
export function readAgain() {
  vi.setSystemTime(Date.now() + 2_000);
  window.dispatchEvent(new Event("visibilitychange"));
}

/** The text `locator`'s element renders, as Playwright's `innerText`. */
export async function innerText(locator: Locator) {
  const element = await locator.findElement();
  return element instanceof HTMLElement ? element.innerText : (element.textContent ?? "");
}

/** The text of each of `locator`'s elements, with its white space collapsed, as Playwright's `toHaveText` reads a list. */
export function texts(locator: Locator) {
  return locator
    .elements()
    .map((element) => (element.textContent ?? "").replace(/\s+/g, " ").trim());
}

/** Whether `locator` has an element that renders, as Playwright's `isVisible`. */
export function isVisible(locator: Locator) {
  return locator.elements().some((element) => element.checkVisibility());
}

/** Whether `locator` has no element that renders, as Playwright's `toBeHidden`. */
export function isHidden(locator: Locator) {
  return !isVisible(locator);
}

/**
 * The words that describe `control` when focus arrives on it, captured then, before later updates
 * to the page can change them.
 */
export function descriptionOnFocus(control: Locator) {
  const words: string[] = [];
  control.element().addEventListener(
    "focusin",
    (event) => {
      const target = event.currentTarget;
      if (!(target instanceof Element)) return;
      for (const part of target.ariaDescribedByElements ?? []) words.push(part.textContent ?? "");
    },
    { once: true },
  );
  return words;
}
