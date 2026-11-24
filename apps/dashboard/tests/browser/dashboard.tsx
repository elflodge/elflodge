import { runWithSignal } from "@orpc/shared";
import { render } from "@solidjs/web";
import { RouterProvider } from "@tanstack/solid-router";
import { asError } from "contract";
import { expect, test as base, vi } from "vite-plus/test";
import { locators, page, server, type Locator } from "vite-plus/test/browser/context";

import { DASHBOARD_BASE } from "../../../hub/src/dashboard.ts";
import { getRouter } from "../../src/router.tsx";
import type { Dropped } from "../../vite.config.ts";
import { createHub } from "../hub.ts";
import { NO_JOBS, NOW, signedIn } from "../records.ts";

declare module "vite-plus/test/browser" {
  interface BrowserCommands {
    /** Taps `locator`'s element with Playwright, in a browser with touch. */
    tap(locator: Locator): Promise<void>;
    /** Forgets the messages the browser's console has shown. */
    clearConsole(): Promise<void>;
    /**
     * The messages the browser's console has shown since `clearConsole`, once one of type `until`
     * has, with their type, and whether their text or any of their arguments holds `text`.
     */
    consoleMessages(text: string, until?: string): Promise<{ type: string; holds: boolean }[]>;
    /** Drops `entries` on `locator`'s element through the browser's own hit test. */
    drop(locator: Locator, entries: Dropped): Promise<void>;
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
 * The test for a dashboard page, mounted in the document the test runs in, against the stand-in
 * for the hub, which answers the page's `fetch` in the same document. Every request the page starts
 * is recorded for the test as it starts, offline too; a `fetch` already aborted starts none. These
 * fail the test, which names them: a call it has no answer for; a `fetch` the stand-in does not
 * answer, or a WebSocket; an arranged answer that throws, other than a procedure's declared refusal,
 * or that the contract refuses, once the page has its answer; and a request whose body the page was
 * still sending, unaborted, as the test ended. Once a test ends, its page's work goes no further
 * through the network: its stand-in answers nothing more, an answer the page
 * has not yet read stops arriving, and nothing answers what the page sends from then until the next
 * test opens a page. `open` mounts the app at an address of the dashboard. Its timers and clock
 * start at `NOW` and move when a test moves them, and as Vitest moves them while an action or a
 * retrying assertion waits, by as much real time as that wait takes: a test cannot hold the clock
 * to the millisecond, so it asserts what a member would notice instead.
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
    // This test's, which a request records itself in as it is sent, even should it go on after.
    const log: Request[] = [];
    sent = log;
    responseWaiters.clear();
    const outgoing = new Set<Outgoing>();
    let mounted: ReturnType<typeof mount> | undefined;
    // Aborted as the test ends, which ends every answer the stand-in is still giving.
    const ended = new AbortController();

    onCleanup(async () => {
      // Nothing the test started is answered from here, nor goes on: what the page is still waiting
      // for stays unanswered, an answer it is still reading stops arriving, and nothing answers a
      // request it sends from now until the next test opens a page.
      ended.abort();
      pageFetch.mockImplementation(never);
      pageWebSocket.mockImplementation(refuseWebSocket);
      mountAgainHere = undefined;
      mounted?.dispose();
      mounted?.destroy();
      vi.useRealTimers();
      // Every request sent before the test ended is the test's to have arranged, so the stand-in
      // records each before the checks below. One whose body the page was still
      // sending is named as such instead: a body need not ever end.
      const sending = [...outgoing].filter((request) => request.sending);
      await Promise.all(
        [...outgoing].filter((request) => !request.sending).map(({ recorded }) => recorded.promise),
      );
      const unarranged = [...network.unarranged, ...strays];
      const failed = [...network.failures, ...failures];
      const problems = [
        ...(unarranged.length > 0
          ? [`Requests the test arranged no answer for:\n${unarranged.join("\n")}`]
          : []),
        ...(failed.length > 0
          ? [`Requests the stand-in failed to answer:\n${failed.join("\n")}`]
          : []),
        ...(sending.length > 0
          ? [
              `Requests the page was still sending as the test ended:\n${sending.map(({ described }) => described).join("\n")}`,
            ]
          : []),
      ];
      if (problems.length > 0) throw new Error(problems.join("\n"));
    });

    /**
     * Takes `request` to the stand-in, which records it before the test may end, whatever becomes of
     * its answer: a stray or a failure, when its answer has none or throws.
     */
    async function takeToStandIn(request: Request, entry: Outgoing) {
      try {
        // The browser's network stack adds Content-Length from the body, which the hub's upload
        // reads; a Request built in the page drops it, but a plain Headers holds it.
        if (request.body) {
          const headers = new Headers(request.headers);
          const body = await runWithSignal(request.signal, () => request.clone().arrayBuffer());
          headers.set("content-length", String(body.byteLength));
          Object.defineProperty(request, "headers", { value: headers });
        }
        entry.sending = false;
        const response = await network.handle(request, () => entry.recorded.resolve());
        if (!response) strays.push(entry.described);
        return { response };
      } catch (error) {
        if (!request.signal.aborted) failures.push(`${entry.described}: ${asError(error).message}`);
        return { error };
      } finally {
        entry.sending = false;
        entry.recorded.resolve();
      }
    }

    return async (path, options = {}) => {
      if (mounted) throw new Error("A test opens one page");
      if (wentOffline) {
        throw new Error("A test that takes the page offline needs a file of its own");
      }
      // Vitest sets the project's viewport once for each file; a test before may have narrowed it.
      const viewport = options.viewport ?? server.config.browser.viewport;
      await page.viewport(viewport.width, viewport.height);
      // Every fetch goes to the stand-in. One it does not answer fails the test as a stray, and one
      // whose answer throws out of it fails the test with the error; each fails in the page as the
      // network fails a request. A request the page aborts, as a deadline does, stops waiting.
      pageFetch.mockImplementation(async (input, init) => {
        const request = new Request(input, init);
        const { signal } = request;
        signal.throwIfAborted();
        log.push(request.clone());
        if (offline) throw new TypeError("Failed to fetch");
        const entry: Outgoing = {
          described: `${request.method} ${request.url}`,
          sending: true,
          recorded: Promise.withResolvers(),
        };
        outgoing.add(entry);
        const answer = takeToStandIn(request, entry);
        let outcome: Awaited<typeof answer>;
        try {
          outcome = await runWithSignal(AbortSignal.any([signal, ended.signal]), () => answer);
        } catch (error) {
          if (ended.signal.aborted) return never();
          throw error;
        }
        const { response } = outcome;
        if (!response) throw new TypeError("Failed to fetch", { cause: outcome.error });
        if (response.type === "error") throw new TypeError("Failed to fetch");
        for (const waiter of responseWaiters) {
          if (!waiter.match(request)) continue;
          responseWaiters.delete(waiter);
          waiter.resolve(response.clone());
        }
        return arrivingUntil(ended.signal, response);
      });
      // The stand-in serves none.
      pageWebSocket.mockImplementation(function (url) {
        strays.push(`WebSocket ${String(url)}`);
        return refuseWebSocket();
      });
      // Every timer and clock of the page, as Vitest fakes them by default.
      vi.useFakeTimers({ now: NOW });
      mounted = mount(DASHBOARD_BASE + path);
      mountAgainHere = (address?: string) => {
        mounted?.dispose();
        mounted?.destroy();
        mounted = mount(address);
      };
      return page;
    };
  });

/** A request of a test's page on its way through the stand-in. */
interface Outgoing {
  readonly described: string;
  /** Whether its body is still being read, before the stand-in can take it. */
  sending: boolean;
  /** Settled once the stand-in has recorded the request, or is done with it. */
  readonly recorded: PromiseWithResolvers<void>;
}

/**
 * Mounts the app at `address` with a router and a Query client of its own, as Start's client does on
 * loading a document: at the base the hub serves it under, into the body, as the app's document
 * renders it, where a dialog makes what is beside it inert.
 */
function mount(address?: string) {
  if (address !== undefined) history.replaceState(null, "", address);
  const router = getRouter();
  router.update({ ...router.options, basepath: DASHBOARD_BASE });
  const dispose = render(() => <RouterProvider router={router} />, document.body);
  return {
    dispose,
    destroy: () => router.history.destroy(),
  };
}

/** The page's `fetch` and `WebSocket`, which `setup.ts` makes spies. */
const pageFetch = vi.mocked(fetch);
const pageWebSocket = vi.mocked(WebSocket);

function refuseWebSocket(): never {
  throw new DOMException("The test serves no WebSocket", "SecurityError");
}

/** What never settles, so nothing waiting for it goes on. */
function never() {
  return new Promise<never>(() => {});
}

/**
 * `response`, whose body stops arriving once `ended` aborts: the page reads it as it asks for it, so
 * what an ended test's page had yet to read never arrives, and nothing that waits for it goes on,
 * even should the body fail. The page aborting the request before then does not fail the body, as
 * the browser fails it with the abort's reason: `text()` and `json()` of a `Response` built in the
 * page fail with a `TypeError` instead, as for a network failure, which the page handles otherwise.
 */
function arrivingUntil(ended: AbortSignal, response: Response) {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (ended.aborted) await never();
        let read: ReadableStreamReadResult<Uint8Array>;
        try {
          read = await reader.read();
        } catch (error) {
          if (ended.aborted) await never();
          throw error;
        }
        if (ended.aborted) await never();
        if (read.done) controller.close();
        else controller.enqueue(read.value);
      },
      cancel: (reason) => reader.cancel(reason),
    },
    // Read only as the page reads.
    { highWaterMark: 0 },
  );
  const { status, statusText, headers } = response;
  return new Response(body, { status, statusText, headers });
}

let offline = false;
/** Whether a test of this file took the page offline. */
let wentOffline = false;

/**
 * Takes the page offline, or back online with `next` false, as the browser tells a page its network
 * went or came back: `navigator.onLine` says so, and `window` hears `offline` or `online`, the
 * events TanStack Query's `onlineManager` follows. While offline, every request fails here, as the
 * network fails it. Whether the browser itself tells the page, when its network goes, is not tested.
 * A test that takes the page offline has a file of its own, as the page's libraries keep what they
 * heard for as long as the document lasts: Better Auth reads the session once back online, and
 * a read that a test's end leaves unanswered keeps it from reading again on the next refusal.
 */
export function setOffline(next: boolean) {
  if (next === offline) return;
  offline = next;
  if (offline) {
    wentOffline = true;
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
  } else Reflect.deleteProperty(navigator, "onLine");
  window.dispatchEvent(new Event(offline ? "offline" : "online"));
}

let mountAgainHere: ((address?: string) => void) | undefined;

/**
 * Mounts the app again at `path`, by default where it stands, its fragment and history state with
 * it, with a new router and Query client, which is what of a reload the document keeps for a test:
 * modules, and the state they hold, stay as they were.
 */
export function mountAgain(path?: string) {
  if (!mountAgainHere) throw new Error("The page is not open");
  mountAgainHere(path === undefined ? undefined : DASHBOARD_BASE + path);
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
  await vi.advanceTimersByTimeAsync(ms);
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

/** What a page says when it could not confirm a write the hub may have made. */
export const UNCERTAIN =
  "The dashboard could not confirm this was done. Check before trying again.";

/** Moves the clock `step` milliseconds at a time until `reached` holds. */
export async function runClockUntil(step: number, reached: () => boolean | Promise<boolean>) {
  await expect
    .poll(async () => {
      await vi.advanceTimersByTimeAsync(step);
      return reached();
    })
    .toBe(true);
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

/**
 * Whether `locator` has an element a member can see, as `toBeVisible` judges one: read once, where
 * `expect.element` would retry, and so move the clock, until it is.
 */
export function isVisible(locator: Locator) {
  return locator.elements().some((element) => {
    try {
      expect(element).toBeVisible();
      return true;
    } catch {
      return false;
    }
  });
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
