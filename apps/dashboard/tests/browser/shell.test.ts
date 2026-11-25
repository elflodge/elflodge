import { expect, vi } from "vite-plus/test";
import { page as testPage, userEvent } from "vite-plus/test/browser/context";

import { DASHBOARD_BASE } from "../../../hub/src/dashboard.ts";
import { NO_JOBS, NO_JOBS_LISTED, signedIn } from "../records.ts";
import {
  advanceTo,
  focus,
  isVisible,
  mountAgain,
  runClockUntil,
  test,
  texts,
} from "./dashboard.tsx";

// The dashboard's signed-in shell: the bar, the hub strip and the member's account. Signing in and
// the document title, which start signed out, are in files of their own. A session ending and a
// second tab, which load the page again, are journeys in the hub's tests (journeys/session.test.ts).

test.for([
  ["hubNotSetUp", "The hub is not set up."],
  ["notMember", "This account is no longer a member of the Organization."],
] as const)(
  "the Organization access notice explains a %s session",
  async ([status, message], { hub, open }) => {
    hub.session.answers({ ...signedIn("owner"), membership: { status } });
    const page = await open("jobs");
    await expect.element(page.getByRole("alert")).toHaveTextContent(message);
  },
);

test("the bar leads to the dashboard's pages, and on a phone names the current one", async ({
  hub,
  open,
}) => {
  hub.jobs.list.answers(NO_JOBS_LISTED);
  const page = await open("change-password");
  const destinations = page.getByRole("navigation", { name: "Destinations" });
  // Every page a member works in.
  const pages = {
    Jobs: "jobs",
    Batches: "batches",
    Runners: "runners",
    Usage: "usage",
    "API keys": "api-keys",
    Organization: "organization",
  };
  const links = destinations.getByRole("link");
  await expect.poll(() => texts(links)).toEqual(Object.keys(pages));
  expect(links.elements().map((link) => link.getAttribute("href"))).toEqual(
    Object.values(pages).map((path) => DASHBOARD_BASE + path),
  );
  await destinations.getByRole("link", { name: "Jobs" }).click();
  await expect.poll(() => location.href).toBe(`${location.origin}${DASHBOARD_BASE}jobs`);
  const jobs = destinations.getByRole("link", { name: "Jobs" });
  // Opened at an address with a filter, the app mounted again there.
  mountAgain("jobs?statusUnknown=true");
  await expect.element(jobs).toHaveAttribute("aria-current", "page");

  // On a phone the current destination is named even while the account menu is closed.
  await page.viewport(390, 844);
  await expect.element(jobs).toHaveLength(0);
  await expect.poll(() => isVisible(page.getByRole("banner").getByText("Jobs"))).toBe(true);
  const name = signedIn("owner").user.name;
  await page.getByRole("button", { name }).click();
  await expect.element(jobs).toHaveAttribute("aria-current", "page");
  await jobs.click({ modifiers: ["ControlOrMeta"] });
  await expect.element(jobs).toBeVisible();
  const menu = page.getByRole("dialog", { name });
  await expect.element(menu).toBeVisible();
  // Following a link from the menu closes it, so it does not cover the page it leads to.
  await destinations.getByRole("link", { name: "Runners" }).click();
  await expect.poll(() => location.href).toBe(`${location.origin}${DASHBOARD_BASE}runners`);
  await expect.element(page.getByRole("heading", { name: "Runners", level: 1 })).toBeVisible();
  await expect.element(menu).toHaveLength(0);
});

test("a refused sign-out keeps the member signed in and says why", async ({ hub, open }) => {
  hub.auth.signOut.fails();
  const signingOut = hub.auth.signOut.hold();
  const page = await open("change-password");
  const name = signedIn("owner").user.name;
  const account = page.getByRole("button", { name });
  await account.click();
  const menu = page.getByRole("dialog", { name });
  await expect.element(menu).toBeVisible();
  const signOut = page.getByRole("button", { name: "Sign out" });
  await signOut.click();
  await signingOut.arrived;
  // While the hub answers, Sign out keeps the focus and takes no second press.
  await expect.element(signOut).toHaveAttribute("aria-busy", "true");
  await expect.element(signOut).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  // Closed and opened again meanwhile, the menu still holds the pending sign-out.
  await userEvent.keyboard("{Escape}");
  await account.click();
  await focus(signOut);
  await userEvent.keyboard("{Enter}");
  signingOut.release();
  // The menu closes to show the notice under it, and focus returns to the member's name.
  await expect.element(page.getByRole("alert")).toBeVisible();
  await expect.element(menu).toHaveLength(0);
  await expect.element(account).toHaveFocus();
  expect(hub.auth.signOut.calls).toHaveLength(1);
});

// Jobs replaces its error page with its loading rows while it reads again; API keys keeps it, with
// Try again holding the focus.
test.for([
  ["jobs", "Jobs"],
  ["api-keys", "API keys"],
] as const)(
  "retrying a failed %s read keeps the dashboard while the session is checked",
  async ([path, heading], { hub, open }) => {
    if (path === "jobs") hub.jobs.list.fails();
    else hub.apiKeys.list.refuses("BAD_REQUEST");
    const page = await open(path);
    const retry = page.getByRole("button", { name: "Try again" });
    await expect.element(retry).toBeVisible();
    await expect.element(page.getByRole("alert")).toMatchTextContent(/could not be read at /);
    // At the first failure, which the hub may clear: the loader does not try again first.
    if (path === "jobs") expect(hub.jobs.list.calls).toHaveLength(1);

    if (path === "jobs") hub.jobs.list.answers(NO_JOBS_LISTED);
    else hub.apiKeys.list.answers([]);
    const reads = hub.session.calls.length;
    const session = hub.session.hold();
    await retry.click();
    await session.arrived;
    if (path === "api-keys") {
      await expect.element(retry).toHaveFocus();
      await expect.element(retry).toHaveAttribute("aria-busy", "true");
      await userEvent.keyboard("{Enter}");
    }
    await expect.element(page.getByRole("banner")).toBeVisible();
    await expect.element(page.getByRole("heading", { name: heading })).toBeVisible();
    session.release();
    // By part of its name, so a control that offers it under a longer name is absent too.
    await expect
      .element(page.getByRole("button", { name: "Try again", exact: false }))
      .toHaveLength(0);
    await expect.element(page.getByRole("heading", { name: heading })).toBeVisible();
    // The list read again, shown.
    await expect
      .element(
        page.getByRole("heading", { name: path === "jobs" ? "No jobs yet" : "No API keys yet" }),
      )
      .toBeVisible();
    // Better Auth's client also reads the session on a timer of its own, which the clock reaches.
    expect(hub.session.calls.length).toBeGreaterThan(reads);
  },
);

test("an address the dashboard has no page for shows that it was not found, in the shell", async ({
  open,
}) => {
  const page = await open("nowhere");
  await expect.element(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await expect.element(page.getByRole("navigation", { name: "Destinations" })).toBeVisible();
});

test("the strip counts the Organization's jobs and lights the lamp while any running job is confirmed", async ({
  hub,
  open,
}) => {
  hub.jobs.counts.answers({
    jobCounts: { queued: 7, running: 0, paused: 0 },
    statusUnknownJobCounts: { queued: 0, running: 0 },
  });
  const page = await open("change-password");
  const strip = page.getByRole("region", { name: "The hub now" });
  await expect.element(strip.getByText("7 queued")).toBeVisible();
  await expect.element(strip.getByText("0 agents running")).toBeVisible();
  await expect.element(strip.getByText("No Runners")).toBeVisible();

  // Three started, two of them still confirmed; the third and the four queued go unheard.
  hub.jobs.counts.answers({
    jobCounts: { queued: 4, running: 3, paused: 0 },
    statusUnknownJobCounts: { queued: 4, running: 1 },
  });
  await vi.advanceTimersByTimeAsync(5_000);
  const running = strip.getByRole("listitem").filter({ hasText: "agents running" });
  await expect.element(running).toHaveTextContent("3 agents running");
  await expect.element(running).not.toHaveClass("hub-unknown");
  await expect.element(running.getByCSS(".mark-running")).toBeVisible();
  await expect.element(running.getByCSS(".mark-running")).not.toHaveClass("is-out");
  await expect.element(strip.getByText("5 status unknown")).toBeVisible();

  hub.jobs.counts.answers({
    jobCounts: { queued: 4, running: 3, paused: 0 },
    statusUnknownJobCounts: { queued: 4, running: 3 },
  });
  await vi.advanceTimersByTimeAsync(5_000);
  await expect.element(running).toHaveTextContent("3 agents running, status unknown");
  await expect.element(running).toHaveClass("hub-unknown");
  await expect.element(running.getByCSS(".mark-unknown")).toBeVisible();
  await expect.element(strip.getByText("7 status unknown")).toBeVisible();
});

test("the strip keeps the last failure visible while the hub is being asked again", async ({
  hub,
  open,
}) => {
  hub.jobs.counts.fails();
  const page = await open("change-password");
  const strip = page.getByRole("region", { name: "The hub now" });
  const failed = strip.getByText(/^The job counts could not be read at /);
  // The outage begins before any counts arrive. Query tries the read again three times, a second,
  // two and four seconds apart, before it reports the failure.
  await runClockUntil(1_000, () => isVisible(failed));
  const failedAt = failed.getByCSS("time").element().getAttribute("datetime");

  // The next poll fails too. During its retry delay the last completed failure still shows.
  const calls = hub.jobs.counts.calls.length;
  await runClockUntil(1_000, () => hub.jobs.counts.calls.length === calls + 1);
  await expect.element(failed.getByCSS("time")).toHaveAttribute("datetime", failedAt ?? "");
  await expect.element(strip.getByText(/ queued$/)).toHaveLength(0);
  hub.jobs.counts.answers(NO_JOBS);
  await runClockUntil(1_000, () => isVisible(strip.getByText(/ queued$/)));
});

test("when a counts read stalls, its figures give way at expiry to the time of the last answer", async ({
  hub,
  open,
}) => {
  const strip = testPage.getByRole("region", { name: "The hub now" });
  const queued = strip.getByText(/ queued$/);
  // The clock's reading as the figures first show, in the same moment their answer lands.
  let shownAt: number | undefined;
  const showing = new MutationObserver(() => {
    if (isVisible(queued)) {
      shownAt ??= Date.now();
      showing.disconnect();
    }
  });
  showing.observe(document.body, { childList: true, subtree: true, characterData: true });
  // The first answer lands three seconds after the page opens, so that its time is not the page's.
  const first = hub.jobs.counts.hold();
  await open("change-password");
  await first.arrived;
  await vi.advanceTimersByTimeAsync(3_000);
  first.release();
  await expect.element(queued).toBeVisible();
  if (shownAt === undefined) throw new Error("The figures showed unobserved");
  // The expiry runs from the answer the figures show, and these steps go to fixed times after they
  // showed, so the expiry is held to between 14 and 15 seconds after the answer however far the clock
  // has moved since. Checked without retrying, since Vitest moves the clock while any assertion retries.
  const reads = hub.jobs.counts.hold();
  await advanceTo(shownAt + 14_000);
  expect(queued.element()).toBeVisible();
  await advanceTo(shownAt + 15_000);
  const lastAnswer = strip.getByText(/^The job counts have not been read since /);
  expect(lastAnswer.element()).toBeVisible();
  // The time of the answer the figures showed, which landed as they first showed.
  const answeredAt = Date.parse(
    lastAnswer.getByCSS("time").element().getAttribute("datetime") ?? "",
  );
  expect(answeredAt).toBeLessThanOrEqual(shownAt);
  expect(shownAt - answeredAt).toBeLessThan(1_000);
  await expect.element(queued).toHaveLength(0);
  await expect.element(strip.getByText("No Runners")).toBeVisible();
  reads.release();
  await expect.element(queued).toBeVisible();
});
