import { type Browser, type Page } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { afterAll, beforeAll, expect, inject, onTestFinished, test } from "vite-plus/test";

import { launchDashboardBrowser } from "./dashboard-browser.ts";
import { startSystem } from "./harness.ts";

// The dashboard as browsers reach it through the hub, on both runtimes, and the rule that keeps
// other sites from acting with a member's session.

const system = startSystem();
const publicOrigin = "http://reference.example.org";
let browser: Browser;

beforeAll(async () => {
  await system.start();
  browser = await launchDashboardBrowser(system, publicOrigin);
});
afterAll(async () => {
  await browser?.close();
  await system.stop();
});

/** A member of the Organization named `name`, added to it, whom a browser can sign in as. */
async function newMember(name: string) {
  const member = {
    name,
    email: `${name.toLowerCase().replaceAll(" ", ".")}@example.com`,
    password: "a long enough password",
  };
  await system.addMember(member);
  return member;
}

/** Opens the dashboard's `pathname` in `page`, signed out, and signs in there as `member`. */
async function signInAt(page: Page, pathname: string, member: { email: string; password: string }) {
  await page.goto(`${system.origin}/dashboard/${pathname}`);
  await page.getByLabel("Email").fill(member.email);
  await page.getByLabel("Password").fill(member.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`${system.origin}/dashboard/${pathname}`);
}

/**
 * Checks that the hub answers a browser's navigation to `pathname` with the app shell. The Workers
 * hub serves the shell for a path with no file of its own only for a navigation.
 */
async function expectShellAt(pathname: string) {
  // Inspect the HTML the hub served before the dashboard can change it or navigate away.
  const page = await browser.newPage({ javaScriptEnabled: false });
  onTestFinished(() => page.close());
  const response = await page.goto(`${system.origin}${pathname}`);
  if (!response) throw new Error(`No response for ${pathname}`);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toMatch(/^text\/html/);
  const scriptPath = await page
    .locator('script[src^="/dashboard/assets/"][src$=".js"]')
    .first()
    .getAttribute("src");
  if (!scriptPath) throw new Error(`No dashboard script in the shell at ${pathname}`);
  return { page, scriptPath };
}

test("dashboard deep links load the shell and caches distinguish missing assets from navigations", async () => {
  await expectShellAt("/dashboard/");
  await expectShellAt("/dashboard/jobs/x");
  // The build's own files stay private: Vite's manifest holds the paths of its sources.
  const { page, scriptPath } = await expectShellAt("/dashboard/.vite/manifest.json");
  const missingPath = "/dashboard/assets/missing.js";
  const missing = await page.evaluate(async (path) => {
    const response = await fetch(path);
    return {
      status: response.status,
      cacheControl: response.headers.get("cache-control"),
      vary: response.headers.get("vary"),
    };
  }, missingPath);
  expect(missing.status).toBe(404);
  expect(missing.cacheControl ?? "").not.toContain("immutable");

  const navigation = await page.goto(`${system.origin}${missingPath}`);
  if (inject("hub") === "workers") {
    const script = await system.hub.fetch(scriptPath);
    expect(script.status).toBe(200);
    for (const vary of [script.headers.get("vary"), navigation?.headers().vary, missing.vary]) {
      expect(vary?.toLowerCase().split(/\s*,\s*/)).toContain("sec-fetch-mode");
    }
  } else {
    expect(navigation?.status()).toBe(404);
  }
  const notices = await system.hub.fetch("/dashboard/THIRD_PARTY_NOTICES.md");
  expect(notices.headers.get("content-type")).toMatch(/^text\/markdown/);

  const root = await system.hub.fetch("/", { redirect: "manual" });
  expect(root.status).toBe(302);
  expect(root.headers.get("location")).toBe("/dashboard/");

  const unslashed = await system.hub.fetch("/dashboard", { redirect: "manual" });
  expect(unslashed.status).toBe(307);
  expect(unslashed.headers.get("location")).toBe("/dashboard/");
});

test.each([system.origin, publicOrigin])(
  "the API reference renders and sends requests on %s",
  async (origin) => {
    const page = await browser.newPage({ serviceWorkers: "block" });
    onTestFinished(() => page.close());
    // Scalar bypasses proxies for localhost. The public-looking host also resolves to loopback.
    if (origin === publicOrigin)
      await page.context().grantPermissions(["local-network-access"], { origin });
    const externalRequests: string[] = [];
    await page.context().route(
      (url) => /^https?:$/.test(url.protocol) && url.origin !== origin,
      (route) => {
        externalRequests.push(route.request().url());
        return route.abort();
      },
    );
    const script = page.waitForResponse((response) => response.url().endsWith("/standalone.js"));
    await page.goto(`${origin}/docs`);
    expect(await page.locator('meta[name="referrer"]').getAttribute("content")).toBe("no-referrer");
    expect((await script).headers()["cache-control"]).toContain("max-age=31536000");
    await page.getByRole("heading", { name: "Elflodge", exact: true }).waitFor();
    await page.evaluate("document.fonts.ready");
    expect(await page.locator('a[href^="https://client.scalar.com"]').count()).toBe(0);
    expect(
      await page.getByRole("button", { name: /Ask AI|Explore Scalar|Generate SDK/i }).count(),
    ).toBe(0);
    await page.getByRole("button", { name: "Test Request (get /setup)", exact: true }).click();
    const target = `${origin}/setup`;
    const [sent] = await Promise.all([
      page.waitForRequest(
        (request) => request.url() === target || new URL(request.url()).origin !== origin,
      ),
      page.getByRole("button", { name: /^Send get request to / }).click(),
    ]);
    expect(sent.url()).toBe(target);
    expect(await sent.headerValue("referer")).toBeNull();
    expect(await (await sent.response())?.json()).toEqual({ needed: false });
    expect(externalRequests).toEqual([]);
  },
);

test("a member's request another site sends is refused, and the same from the hub served", async () => {
  const client = await system.clientWithNewJobsKey();
  const batch = await client.batches.create({ agent: { outputContract: { schema: {} } } });
  /** Pauses the Batch with the owner's session, with no body, from a page at `origin`. */
  const pauseFrom = (origin: string, site: string) =>
    system.hub.fetch(`/batches/${batch.id}/pause`, {
      method: "POST",
      headers: { cookie: system.ownerCookie(), origin, "sec-fetch-site": site },
    });

  const refused = await pauseFrom("https://elsewhere.example", "cross-site");
  expect(refused.status).toBe(403);
  expect((await client.batches.get({ id: batch.id })).status).toBe("active");

  const served = await pauseFrom(system.origin, "same-origin");
  expect(served.status).toBe(200);
  expect((await client.batches.get({ id: batch.id })).status).toBe("paused");

  // A caller with an API key, such as a script or a Runner, sends no `Origin`, here with no body.
  const resumed = await system.hub.fetch(`/batches/${batch.id}/resume`, {
    method: "POST",
    headers: { "x-api-key": await system.newJobsKey() },
  });
  expect(resumed.status).toBe(200);
});

test("a request with neither a session nor a key is told how to authenticate", async () => {
  const response = await system.hub.fetch("/batches/x/pause", { method: "POST" });
  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).not.toBeNull();
});

test("sign-in allows keyboard retry, stays disabled during navigation and discards an off-site redirect", async () => {
  const page = await browser.newPage();
  onTestFinished(() => page.close());
  const member = await newMember("Keyboard Reader");
  // A destination on another site is discarded, so signing in leads home.
  await page.goto(`${system.origin}/dashboard/sign-in?redirect=//elsewhere.example/other`);
  await page.getByLabel("Email").fill(member.email);
  const password = page.getByLabel("Password");
  await password.fill("incorrect password");
  const submit = page.getByRole("button", { name: "Sign in" });
  await submit.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("alert").waitFor();
  await expectBrowser(submit).toBeFocused();

  // Hold the destination's first read after the hub has accepted the password.
  const release = Promise.withResolvers<void>();
  await page.route("**/api/auth/get-session", async (route) => {
    await release.promise;
    await route.continue();
  });
  const reading = page.waitForRequest("**/api/auth/get-session");
  await password.fill(member.password);
  await submit.click();
  try {
    await reading;
    await expectBrowser(submit).toBeDisabled();
  } finally {
    release.resolve();
  }
  await page.getByRole("heading", { name: "Connected to your hub" }).waitFor();
}, 30_000);

test("in a browser, the bar leads to the dashboard's pages", async () => {
  const page = await browser.newPage();
  onTestFinished(() => page.close());
  const member = await newMember("Nav Reader");
  await signInAt(page, "change-password", member);

  const destinations = page.getByRole("navigation", { name: "Destinations" });
  await destinations.getByRole("link", { name: "Home" }).click();
  await page.waitForURL(`${system.origin}/dashboard/`);
  const home = destinations.getByRole("link", { name: "Home" });
  await page.goto(`${system.origin}/dashboard/?view=recent`);
  await expectBrowser(home).toHaveAttribute("aria-current", "page");

  // On a phone the current destination is named even while the account menu is closed.
  await page.setViewportSize({ width: 390, height: 844 });
  await expectBrowser(home).toBeHidden();
  await expectBrowser(
    page.getByRole("banner").getByText("Home", { exact: true }).filter({ visible: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: member.name }).click();
  await expectBrowser(home).toHaveAttribute("aria-current", "page");
  await home.click({ modifiers: ["ControlOrMeta"] });
  await expectBrowser(home).toBeVisible();
}, 30_000);

test("in a browser, an address the dashboard has no page for shows that it was not found", async () => {
  const page = await browser.newPage();
  onTestFinished(() => page.close());
  // Signed out, it is a page like any other: signing in comes first.
  await signInAt(page, "nowhere", await newMember("Lost Reader"));
  // Signed in, the bar stays.
  await page.getByRole("heading", { name: "Not found" }).waitFor();
  await page.getByRole("navigation", { name: "Destinations" }).waitFor();
}, 30_000);

test("in a browser, the strip under the bar counts the Organization's Runners and jobs", async () => {
  const client = await system.clientWithNewJobsKey();
  const batch = await client.batches.create({ agent: { outputContract: { schema: {} } } });
  await client.batches.addJobs({
    id: batch.id,
    jobs: [
      { customId: "one", input: "One." },
      { customId: "two", input: "Two." },
    ],
  });
  const { jobCounts } = await client.jobs.counts({});

  const page = await browser.newPage();
  onTestFinished(() => page.close());
  await signInAt(page, "", await newMember("Strip Reader"));
  const strip = page.getByRole("region", { name: "The hub now" });
  await strip.getByText(`${jobCounts.queued} queued`).waitFor();
  await strip.getByText("0 agents running").waitFor();
  await strip.getByText("No Runners").waitFor();
}, 30_000);

/** Freeze the page clock before navigation so a hub answer has a known instant. */
async function pageWithPausedClock() {
  const page = await browser.newPage();
  onTestFinished(() => page.close());
  await page.clock.install({ time: new Date("2026-11-18T15:40:00Z") });
  await page.clock.pauseAt(new Date("2026-11-18T15:41:00Z"));
  return page;
}

test("going offline immediately replaces all the strip's figures with one untimed line", async () => {
  const page = await pageWithPausedClock();
  await signInAt(page, "", await newMember("Offline Reader"));
  const strip = page.getByRole("region", { name: "The hub now" });
  await strip.getByText(/ queued$/).waitFor();
  await page.context().setOffline(true);
  await expectBrowser(strip.getByRole("listitem")).toHaveText([
    "The hub cannot be read: this browser is offline.",
  ]);
}, 30_000);

test("the strip keeps the last failure visible while the hub is being asked again", async () => {
  const page = await pageWithPausedClock();
  await page.route("**/jobs/counts", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/problem+json",
      body: JSON.stringify({ type: "about:blank", title: "Service Unavailable", status: 503 }),
    }),
  );
  await signInAt(page, "", await newMember("Outage Reader"));
  const strip = page.getByRole("region", { name: "The hub now" });
  const failed = strip.getByText(/^The job counts could not be read at /);
  // The outage begins before any counts arrive. Let Query finish its first series of retries.
  await expectBrowser
    .poll(async () => {
      await page.clock.fastForward("01:00");
      return failed.isVisible();
    })
    .toBe(true);
  const failureTime = await failed.locator("time").innerText();

  // The next poll also fails. During its retry delay the last completed failure still shows.
  const next = page.waitForResponse("**/jobs/counts");
  await page.clock.fastForward("01:00");
  await (await next).finished();
  await expectBrowser(failed.locator("time")).toHaveText(failureTime);
  await page.unroute("**/jobs/counts");
  await page.clock.fastForward("01:00");
  await expectBrowser(strip.getByText(/ queued$/)).toBeVisible();
}, 30_000);

test("when a counts read stalls, its figures give way at expiry to the time of the last answer", async () => {
  const page = await pageWithPausedClock();
  await signInAt(page, "", await newMember("Waiting Reader"));
  const strip = page.getByRole("region", { name: "The hub now" });
  const queued = strip.getByText(/ queued$/);
  await queued.waitFor();
  const release = Promise.withResolvers<void>();
  await page.route("**/jobs/counts", async (route) => {
    await release.promise;
    await route.continue();
  });
  try {
    await page.clock.fastForward(14_999);
    await expectBrowser(queued).toBeVisible();
    await page.clock.fastForward(1);
    const lastAnswer = strip.getByText(/^The job counts have not been read since /);
    await expectBrowser(lastAnswer.locator("time")).toHaveAttribute(
      "datetime",
      "2026-11-18T15:41:00.000Z",
    );
    await expectBrowser(queued).toHaveCount(0);
    await expectBrowser(strip.getByText("No Runners")).toBeVisible();
  } finally {
    release.resolve();
  }
  await expectBrowser(queued).toBeVisible();
}, 30_000);

test("in a browser, a member change in another tab loads a fresh document", async () => {
  const first = await newMember("First Tab Reader");
  const next = await newMember("Next Tab Reader");
  // Two tabs of one browser, which share its cookies.
  const context = await browser.newContext();
  onTestFinished(() => context.close());
  const page = await context.newPage();
  const other = await context.newPage();
  const dashboard = `${system.origin}/dashboard`;

  await signInAt(other, "", first);
  await page.goto(`${dashboard}/change-password`);
  await page.getByRole("button", { name: first.name }).waitFor();
  const firstDocument = await page.evaluate(() => performance.timeOrigin);
  await other.getByRole("button", { name: first.name }).click();
  await other.getByRole("button", { name: "Sign out" }).click();
  await other.waitForURL(`${dashboard}/sign-in`);
  await page.getByRole("heading", { name: "Sign in to Elflodge" }).waitFor();
  const signInDocument = await page.evaluate(() => performance.timeOrigin);
  expect(signInDocument).not.toBe(firstDocument);

  // Signed in as the next member in the other tab, over this one's session, this one shows the next
  // member at its next session read.
  await page.getByLabel("Email").fill(first.email);
  await page.getByLabel("Password").fill(first.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: first.name }).waitFor();
  await page.waitForURL(`${dashboard}/change-password`);
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(signInDocument);
  await other.getByLabel("Email").fill(next.email);
  await other.getByLabel("Password").fill(next.password);
  await other.getByRole("button", { name: "Sign in" }).click();
  await other.getByRole("button", { name: next.name }).waitFor();
  const home = page
    .getByRole("navigation", { name: "Destinations" })
    .getByRole("link", { name: "Home" });
  // The preload observes the new member while the pointer is over Home. The current page reloads.
  await home.hover();
  await page.getByRole("button", { name: next.name }).waitFor();
  expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(signInDocument);
  await expectBrowser(page).toHaveURL(`${dashboard}/change-password`);
}, 60_000);

test("in a browser, a member signs in, reloads a page, changes the password and signs out", async () => {
  const page = await browser.newPage();
  onTestFinished(() => page.close());
  const dashboard = `${system.origin}/dashboard`;

  // Signed out, a page sends the member to sign in, and back to it once signed in.
  const member = await newMember("Password Reader");
  await signInAt(page, "change-password", member);
  // The bar names who is signed in; their name opens the account menu.
  const account = page.getByRole("button", { name: member.name, exact: true });
  await account.waitFor();

  await page.reload();
  const heading = page.getByRole("heading", { name: "Change password" });
  await heading.waitFor();

  // A wrong current password is refused at its field, not with words that could mean any of three.
  const password = "a new password for this member";
  const current = page.getByLabel("Current password");
  await current.fill("incorrect password");
  await page.getByLabel("New password", { exact: true }).fill(password);
  await page.getByLabel("Confirm new password").fill(password);
  await page.getByRole("button", { name: "Change password" }).click();
  await expectBrowser(current).toHaveAttribute("aria-invalid", "true");
  await expectBrowser(current).toHaveAccessibleDescription("That is not your current password.");
  await expectBrowser(current).toBeFocused();

  await current.fill(member.password);
  // The change makes a new session for the same member, which the page reads; it stays, and so does
  // what it said.
  const signedInDocument = await page.evaluate(() => performance.timeOrigin);
  const sessionRead = page.waitForResponse(
    (response) =>
      response.url().includes("/api/auth/get-session") && response.request().method() === "GET",
  );
  await page.getByRole("button", { name: "Change password" }).click();
  await page.getByRole("status").waitFor();
  await sessionRead;
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(signedInDocument);
  await expectBrowser(page.getByRole("status")).toHaveText(/^Your password is changed/);

  await account.click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(`${dashboard}/sign-in`);
  await page.getByRole("heading", { name: "Sign in to Elflodge" }).waitFor();
  expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(signedInDocument);
  // The new password signs in.
  await system.signIn({ email: member.email, password });
}, 30_000);
