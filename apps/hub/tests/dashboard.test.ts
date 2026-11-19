import { type Browser, type Page, chromium } from "playwright";
import { afterAll, beforeAll, expect, inject, onTestFinished, test } from "vite-plus/test";

import { setUpOrganization } from "../src/setup.ts";
import { clearDatabase, OWNER, startSystem } from "./harness.ts";

// The dashboard as browsers reach it through the hub, on both runtimes, and the rule that keeps
// other sites from acting with a member's session.

const system = startSystem();
let browser: Browser;

beforeAll(async () => {
  await system.start();
  // The browser reaches the hub at the origin it serves, which is the only one it signs members in
  // from, by resolving that origin's host to where the test hub listens.
  browser = await chromium.launch({
    args: [`--host-resolver-rules=MAP ${new URL(system.origin).hostname} ${system.url().host}`],
  });
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

  const unslashed = await system.hub.fetch("/dashboard", { redirect: "manual" });
  expect(unslashed.status).toBe(307);
  expect(unslashed.headers.get("location")).toBe("/dashboard/");
});

test("the hub's root leads to the dashboard, and its API reference is at /docs", async () => {
  const root = await system.hub.fetch("/", { redirect: "manual" });
  expect(root.status).toBe(302);
  expect(root.headers.get("location")).toBe("/dashboard/");

  const reference = await system.hub.fetch("/docs");
  expect(reference.status).toBe(200);
  expect(reference.headers.get("content-type")).toMatch(/^text\/html/);
  expect(await reference.text()).toContain("@scalar/api-reference");
});

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

test("a member can retry a refused sign-in from the keyboard and submits only once while navigating", async () => {
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
  expect(await submit.evaluate((button) => button.matches(":focus"))).toBe(true);

  // Hold the destination's first read after the hub has accepted the password.
  const release = Promise.withResolvers<void>();
  await page.route("**/api/auth/organization/list", async (route) => {
    await release.promise;
    await route.continue();
  });
  const reading = page.waitForRequest("**/api/auth/organization/list");
  await password.fill(member.password);
  await submit.click();
  try {
    await reading;
    expect(await submit.isDisabled()).toBe(true);
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
  expect(await home.getAttribute("aria-current")).toBe("page");

  // On a phone the destinations are in the menu the Member's name opens.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: member.name }).click();
  expect(await destinations.getByRole("link", { name: "Home" }).getAttribute("aria-current")).toBe(
    "page",
  );
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

test("in a browser, a failed read of the counts says so in the strip, not with the last counts", async () => {
  const page = await browser.newPage();
  onTestFinished(() => page.close());
  await signInAt(page, "", await newMember("Failing Reader"));
  const strip = page.getByRole("region", { name: "The hub now" });
  await strip.getByText(/ queued$/).waitFor();

  // The hub stops answering; the strip's next read, within its refresh, fails.
  await page.route("**/jobs/counts", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/problem+json",
      body: JSON.stringify({ type: "about:blank", title: "Service Unavailable", status: 503 }),
    }),
  );
  await strip.getByText(/^The job counts could not be read at /).waitFor({ timeout: 45_000 });
  expect(await strip.getByText(/ queued$/).count()).toBe(0);
  // The bar stays.
  await page.getByRole("navigation", { name: "Destinations" }).waitFor();
}, 60_000);

test("in a browser, a member change in another tab loads a fresh document", async () => {
  const client = await system.clientWithNewJobsKey();
  const batch = await client.batches.create({ agent: { outputContract: { schema: {} } } });
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
  // member at its next session read, with a fresh set of counts.
  await page.getByLabel("Email").fill(first.email);
  await page.getByLabel("Password").fill(first.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: first.name }).waitFor();
  await page.waitForURL(`${dashboard}/change-password`);
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(signInDocument);
  const queued = page.getByRole("region", { name: "The hub now" }).getByText(/^[\d,]+ queued$/);
  const before = Number((await queued.innerText()).replaceAll(",", "").split(" ")[0]);
  await client.batches.addJobs({
    id: batch.id,
    jobs: [{ customId: "one more in a tab", input: "One more." }],
  });
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
  expect(page.url()).toBe(`${dashboard}/change-password`);
  expect(await queued.innerText()).toBe(`${before + 1} queued`);
}, 60_000);

// After the tests that add members: the owner's password change ends the owner's other sessions,
// with which members are added.
test("in a browser, a member signs in, reloads a page, changes the password and signs out", async () => {
  const page = await browser.newPage();
  onTestFinished(() => page.close());
  const dashboard = `${system.origin}/dashboard`;

  // Signed out, a page sends the member to sign in, and back to it once signed in.
  await page.goto(`${dashboard}/change-password`);
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`${dashboard}/change-password`);
  // The bar names who is signed in; their name opens the account menu.
  const account = page.getByRole("button", { name: "Owner", exact: true });
  await account.waitFor();

  await page.reload();
  const heading = page.getByRole("heading", { name: "Change password" });
  await heading.waitFor();

  // A wrong current password is refused at its field, not with words that could mean any of three.
  const password = "a new password for the owner";
  const current = page.getByLabel("Current password");
  await current.fill("not the owner's password");
  await page.getByLabel("New password", { exact: true }).fill(password);
  await page.getByLabel("Confirm new password").fill(password);
  await page.getByRole("button", { name: "Change password" }).click();
  const refusal = page.getByText("That is not your current password.");
  await refusal.waitFor();
  expect(await current.getAttribute("aria-invalid")).toBe("true");
  const describedBy = await current.getAttribute("aria-describedby");
  expect(await page.locator(`#${describedBy}`).innerText()).toBe(
    "That is not your current password.",
  );
  // The focus is on the field to correct, which already says why.
  expect(await current.evaluate((input) => input.matches(":focus"))).toBe(true);

  await current.fill(OWNER.password);
  await page.getByLabel("New password", { exact: true }).fill(password);
  await page.getByLabel("Confirm new password").fill(password);
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
  expect(await page.getByRole("status").innerText()).toMatch(/^Your password is changed/);

  await account.click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(`${dashboard}/sign-in`);
  await page.getByRole("heading", { name: "Sign in to Elflodge" }).waitFor();
  expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(signedInDocument);
  // The new password signs in.
  await system.signIn({ email: OWNER.email, password });
}, 30_000);

// Last, as it empties the hub.
test("in a browser, the setup link creates the Organization and its owner, who is then signed in", async () => {
  await clearDatabase(inject("databaseUrl"));
  let link = "";
  await setUpOrganization(
    inject("databaseUrl"),
    { owner: {}, hubUrl: system.origin },
    (message) => {
      link = message.split("\n").at(-1) ?? "";
    },
  );
  const page = await browser.newPage();
  onTestFinished(() => page.close());
  const dashboard = `${system.origin}/dashboard`;

  // Signing in leads to setup while the hub has no owner.
  await page.goto(`${dashboard}/sign-in`);
  await page.getByText("Open the setup link").waitFor();

  await page.goto(link);
  const owner = { email: "new-owner@example.com", password: "a long enough password" };
  await page.getByLabel("Organization name").fill("Harbor & Pine");
  await page.getByLabel("Your name").fill("Robin Hale");
  await page.getByLabel("Email").fill(owner.email);
  await page.getByLabel("Password").fill(owner.password);
  await page.getByRole("button", { name: "Create owner" }).click();
  await page.waitForURL(`${dashboard}/`);
  await page.getByRole("banner").getByText("Harbor & Pine", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Robin Hale" }).click();
  await page.getByText(owner.email).waitFor();
}, 30_000);
