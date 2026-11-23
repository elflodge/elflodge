import type { Page } from "playwright";
import { expect } from "vite-plus/test";

import { DASHBOARD_BASE } from "../../hub/src/dashboard.ts";
import { expectBrowser, runClockUntil, test } from "./dashboard.ts";
import type { Hub, Session } from "./hub.ts";
import { NO_JOBS, NOW, signedIn } from "./records.ts";

// The dashboard's signed-in shell and what leads into it: signing in, the bar, page titles, the hub
// strip and the member's account.

/** The first page of the jobs list, with no jobs. */
const NO_JOBS_LISTED = { jobs: [], hasMore: false };

/** Arranges a hub whose sign-in accepts `session`'s member. */
function acceptSignIn(hub: Hub, session: NonNullable<Session>) {
  hub.setup.get.answers({ needed: false });
  hub.auth.signIn.email.answers({
    redirect: false,
    token: session.session.token,
    user: session.user,
  });
}

/** Signs in on the sign-in page `page` shows, as the member `session` names. */
async function signIn(page: Page, session: NonNullable<Session>) {
  await page.getByLabel("Email").fill(session.user.email);
  await page.getByLabel("Password").fill("a member's password");
  await page.getByRole("button", { name: "Sign in" }).click();
}

/**
 * Marks the document `page` shows, and returns a check of whether it still shows that one or has
 * loaded another.
 */
async function markDocument(page: Page) {
  const mark = crypto.randomUUID();
  await page.evaluate((value) => Reflect.set(window, "documentMark", value), mark);
  return async () => (await page.evaluate(() => Reflect.get(window, "documentMark"))) === mark;
}

test("sign-in allows keyboard retry, takes only one submit during navigation and discards an off-site redirect", async ({
  hub,
  open,
}) => {
  const owner = signedIn("owner");
  hub.session.answers(null);
  hub.setup.get.answers({ needed: false });
  hub.auth.signIn.email.refuses("UNAUTHORIZED", "INVALID_EMAIL_OR_PASSWORD");
  hub.jobs.list.answers(NO_JOBS_LISTED);
  // A destination on another site is discarded, so signing in opens the Jobs list.
  const page = await open("sign-in?redirect=//elsewhere.example/other");
  await page.getByLabel("Email").fill(owner.user.email);
  const password = page.getByLabel("Password");
  await password.fill("incorrect password");
  const submit = page.getByRole("button", { name: "Sign in" });
  await submit.focus();
  await page.keyboard.press("Enter");
  await expectBrowser(page.getByRole("alert")).toBeVisible();
  await expectBrowser(submit).toBeFocused();

  // The hub accepts the password, and the destination's first read of the session is held.
  acceptSignIn(hub, owner);
  hub.session.answers(owner);
  const reads = hub.session.hold();
  await password.fill("a member's password");
  await submit.click();
  await reads.arrived;
  await expectBrowser(submit).toBeDisabled();
  await page.keyboard.press("Enter");
  await page.locator("form").evaluate((form: HTMLFormElement) => form.requestSubmit());
  reads.release();
  await expectBrowser(page.getByRole("heading", { name: "Jobs", level: 1 })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(`${DASHBOARD_BASE}jobs`);
  expect(hub.auth.signIn.email.calls).toEqual([
    { email: owner.user.email, password: "incorrect password" },
    { email: owner.user.email, password: "a member's password" },
  ]);
});

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
  await expectBrowser(links).toHaveText(Object.keys(pages));
  expect(await links.evaluateAll((all) => all.map((link) => link.getAttribute("href")))).toEqual(
    Object.values(pages).map((path) => DASHBOARD_BASE + path),
  );
  await destinations.getByRole("link", { name: "Jobs" }).click();
  await page.waitForURL(`${DASHBOARD_BASE}jobs`);
  const jobs = destinations.getByRole("link", { name: "Jobs" });
  await page.goto(`${DASHBOARD_BASE}jobs?statusUnknown=true`);
  await expectBrowser(jobs).toHaveAttribute("aria-current", "page");

  // On a phone the current destination is named even while the account menu is closed.
  await page.setViewportSize({ width: 390, height: 844 });
  await expectBrowser(jobs).toBeHidden();
  await expectBrowser(
    page.getByRole("banner").getByText("Jobs", { exact: true }).filter({ visible: true }),
  ).toBeVisible();
  const name = signedIn("owner").user.name;
  await page.getByRole("button", { name }).click();
  await expectBrowser(jobs).toHaveAttribute("aria-current", "page");
  await jobs.click({ modifiers: ["ControlOrMeta"] });
  await expectBrowser(jobs).toBeVisible();
  const menu = page.getByRole("dialog", { name });
  await expectBrowser(menu).toBeVisible();
  // Following a link from the menu closes it, so it does not cover the page it leads to.
  await destinations.getByRole("link", { name: "Runners" }).click();
  await page.waitForURL(`${DASHBOARD_BASE}runners`);
  await expectBrowser(page.getByRole("heading", { name: "Runners", level: 1 })).toBeVisible();
  await expectBrowser(menu).toBeHidden();
});

test("a refused sign-out keeps the member signed in and says why", async ({ hub, open }) => {
  hub.auth.signOut.fails();
  const signingOut = hub.auth.signOut.hold();
  const page = await open("change-password");
  const name = signedIn("owner").user.name;
  const account = page.getByRole("button", { name, exact: true });
  await account.click();
  const menu = page.getByRole("dialog", { name });
  await expectBrowser(menu).toBeVisible();
  const signOut = page.getByRole("button", { name: "Sign out" });
  await signOut.click();
  await signingOut.arrived;
  // While the hub answers, Sign out keeps the focus and takes no second press.
  await expectBrowser(signOut).toHaveAttribute("aria-busy", "true");
  await expectBrowser(signOut).toBeFocused();
  await page.keyboard.press("Enter");
  // Closed and opened again meanwhile, the menu still holds the pending sign-out.
  await page.keyboard.press("Escape");
  await account.click();
  await signOut.focus();
  await page.keyboard.press("Enter");
  signingOut.release();
  // The menu closes to show the notice under it, and focus returns to the member's name.
  await expectBrowser(page.getByRole("alert")).toBeVisible();
  await expectBrowser(menu).toBeHidden();
  await expectBrowser(account).toBeFocused();
  expect(hub.auth.signOut.calls).toHaveLength(1);
});

test("the document title names the page across a navigation and back", async ({ hub, open }) => {
  const owner = signedIn("owner");
  hub.session.answers(null);
  acceptSignIn(hub, owner);
  const page = await open("change-password");
  await expectBrowser(page).toHaveTitle("Sign in · Elflodge");
  hub.session.answers(owner);
  await signIn(page, owner);
  await expectBrowser(page).toHaveTitle("Change password · Elflodge");
  await page
    .getByRole("navigation", { name: "Destinations" })
    .getByRole("link", { name: "Runners" })
    .click();
  await expectBrowser(page).toHaveTitle("Runners · Elflodge");
  await page.goBack();
  await expectBrowser(page).toHaveTitle("Change password · Elflodge");
  await page.goForward();
  await expectBrowser(page).toHaveTitle("Runners · Elflodge");
});

// Jobs replaces its error page with its loading rows while it reads again; API keys keeps it, with
// Try again holding the focus.
test.for([
  ["jobs", "Jobs"],
  ["api-keys", "API keys"],
] as const)(
  "retrying a failed %s read keeps the dashboard while the session is checked",
  async ([path, heading], { hub, open }) => {
    if (path === "jobs") hub.jobs.list.refuses("BAD_REQUEST");
    else hub.apiKeys.list.refuses("BAD_REQUEST");
    const page = await open(path);
    const retry = page.getByRole("button", { name: "Try again" });
    await expectBrowser(retry).toBeVisible();
    await expectBrowser(page.getByRole("alert")).toHaveText(/could not be read at /);

    if (path === "jobs") hub.jobs.list.answers(NO_JOBS_LISTED);
    else hub.apiKeys.list.answers([]);
    const reads = hub.session.calls.length;
    const session = hub.session.hold();
    await retry.click();
    await session.arrived;
    if (path === "api-keys") {
      await expectBrowser(retry).toBeFocused();
      await expectBrowser(retry).toHaveAttribute("aria-busy", "true");
      await page.keyboard.press("Enter");
    }
    await expectBrowser(page.getByRole("banner")).toBeVisible();
    await expectBrowser(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    session.release();
    await expectBrowser(retry).toBeHidden();
    await expectBrowser(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    expect(hub.session.calls).toHaveLength(reads + 1);
  },
);

test("an address the dashboard has no page for shows that it was not found, in the shell", async ({
  open,
}) => {
  const page = await open("nowhere");
  await expectBrowser(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await expectBrowser(page.getByRole("navigation", { name: "Destinations" })).toBeVisible();
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
  await expectBrowser(strip.getByText("7 queued", { exact: true })).toBeVisible();
  await expectBrowser(strip.getByText("0 agents running")).toBeVisible();
  await expectBrowser(strip.getByText("No Runners")).toBeVisible();

  // Three started, two of them still confirmed; the third and the four queued go unheard.
  hub.jobs.counts.answers({
    jobCounts: { queued: 4, running: 3, paused: 0 },
    statusUnknownJobCounts: { queued: 4, running: 1 },
  });
  await page.clock.runFor(5_000);
  const running = strip.getByRole("listitem").filter({ hasText: "agents running" });
  await expectBrowser(running).toHaveText("3 agents running");
  await expectBrowser(running).not.toContainClass("hub-unknown");
  await expectBrowser(running.locator(".mark-running")).toBeVisible();
  await expectBrowser(running.locator(".mark-running")).not.toContainClass("is-out");
  await expectBrowser(strip.getByText("5 status unknown", { exact: true })).toBeVisible();

  hub.jobs.counts.answers({
    jobCounts: { queued: 4, running: 3, paused: 0 },
    statusUnknownJobCounts: { queued: 4, running: 3 },
  });
  await page.clock.runFor(5_000);
  await expectBrowser(running).toHaveText("3 agents running, status unknown");
  await expectBrowser(running).toContainClass("hub-unknown");
  await expectBrowser(running.locator(".mark-unknown")).toBeVisible();
  await expectBrowser(strip.getByText("7 status unknown", { exact: true })).toBeVisible();
});

test("going offline immediately replaces all the strip's figures with one untimed line", async ({
  open,
}) => {
  const page = await open("change-password");
  const strip = page.getByRole("region", { name: "The hub now" });
  await expectBrowser(strip.getByText(/ queued$/)).toBeVisible();
  await page.context().setOffline(true);
  await expectBrowser(strip.getByRole("listitem")).toHaveText([
    "The hub cannot be read: this browser is offline.",
  ]);
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
  await runClockUntil(page, 1_000, () => failed.isVisible());
  const failedAt = await failed.locator("time").getAttribute("datetime");

  // The next poll fails too. During its retry delay the last completed failure still shows.
  const calls = hub.jobs.counts.calls.length;
  await runClockUntil(page, 1_000, () => hub.jobs.counts.calls.length === calls + 1);
  await expectBrowser(failed.locator("time")).toHaveAttribute("datetime", failedAt ?? "");
  await expectBrowser(strip.getByText(/ queued$/)).toHaveCount(0);
  hub.jobs.counts.answers(NO_JOBS);
  await runClockUntil(page, 1_000, () => strip.getByText(/ queued$/).isVisible());
});

test("when a counts read stalls, its figures give way at expiry to the time of the last answer", async ({
  hub,
  open,
}) => {
  const page = await open("change-password");
  const strip = page.getByRole("region", { name: "The hub now" });
  const queued = strip.getByText(/ queued$/);
  await expectBrowser(queued).toBeVisible();
  const reads = hub.jobs.counts.hold();
  await page.clock.runFor(14_999);
  await expectBrowser(queued).toBeVisible();
  await page.clock.runFor(1);
  const lastAnswer = strip.getByText(/^The job counts have not been read since /);
  await expectBrowser(lastAnswer.locator("time")).toHaveAttribute("datetime", NOW.toISOString());
  await expectBrowser(queued).toHaveCount(0);
  await expectBrowser(strip.getByText("No Runners")).toBeVisible();
  reads.release();
  await expectBrowser(queued).toBeVisible();
});

test("an open dashboard returns to sign-in when a background read discovers the session ended", async ({
  hub,
  open,
}) => {
  hub.jobs.list.answers(NO_JOBS_LISTED);
  hub.setup.get.answers({ needed: false });
  const page = await open("jobs");
  await expectBrowser(page.getByRole("heading", { name: "Jobs", level: 1 })).toBeVisible();
  // Better Auth's client makes its first read of the session the shell watches on a timer, which
  // the paused clock fires only as the test moves it: made while the session holds.
  const reads = hub.session.calls.length;
  await runClockUntil(page, 10, () => hub.session.calls.length > reads);
  const watched = hub.session.calls.length;

  // The session ends without a sign-out in this browser or a navigation: the hub strip's next poll
  // of the counts is refused, and a session read then names no one.
  hub.session.answers(null);
  hub.jobs.counts.refuses("UNAUTHORIZED");
  await page.clock.runFor(5_000);
  await expectBrowser(page.getByRole("heading", { name: "Sign in to Elflodge" })).toBeVisible();
  expect(hub.session.calls.length).toBeGreaterThan(watched);
  expect(new URL(page.url()).searchParams.get("redirect")).toContain("/jobs");
});

test("a member change in another tab loads a fresh document", async ({ hub, open }) => {
  const first = signedIn("owner");
  const next = signedIn("admin");
  hub.jobs.list.answers(NO_JOBS_LISTED);
  hub.setup.get.answers({ needed: false });
  hub.session.answers(first);
  const page = await open("change-password");
  await expectBrowser(page.getByRole("button", { name: first.user.name })).toBeVisible();
  const firstDocument = await markDocument(page);
  // A second tab of the same browser.
  const other = await open("jobs");
  await expectBrowser(other.getByRole("button", { name: first.user.name })).toBeVisible();

  // Signed out in the other tab, this one, at its next session read, loads the sign-in page anew.
  hub.auth.signOut.answers({ success: true, url: undefined, redirect: false });
  hub.session.answers(null);
  await other.getByRole("button", { name: first.user.name }).click();
  await other.getByRole("button", { name: "Sign out" }).click();
  await other.waitForURL(/\/sign-in/);
  await expectBrowser(page.getByRole("heading", { name: "Sign in to Elflodge" })).toBeVisible();
  expect(await firstDocument()).toBe(false);
  const signInDocument = await markDocument(page);

  // Signing in here keeps the document, which had shown no member.
  acceptSignIn(hub, first);
  hub.session.answers(first);
  await signIn(page, first);
  await expectBrowser(page.getByRole("button", { name: first.user.name })).toBeVisible();
  await page.waitForURL(`${DASHBOARD_BASE}change-password`);
  expect(await signInDocument()).toBe(true);

  // Signed in as the next member in the other tab, over this one's session, this one shows the next
  // member at its next session read, such as the one the router's preload of a link the pointer
  // rests on makes after a moment.
  await other.getByRole("button", { name: "Sign out" }).waitFor({ state: "detached" });
  acceptSignIn(hub, next);
  hub.session.answers(next);
  await signIn(other, next);
  await page
    .getByRole("navigation", { name: "Destinations" })
    .getByRole("link", { name: "Jobs" })
    .hover();
  await page.clock.runFor(1_000);
  await expectBrowser(page.getByRole("button", { name: next.user.name })).toBeVisible();
  expect(await signInDocument()).toBe(false);
  expect(new URL(page.url()).pathname).toBe(`${DASHBOARD_BASE}change-password`);
});
