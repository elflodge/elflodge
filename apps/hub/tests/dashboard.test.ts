import type { Browser } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { afterAll, beforeAll, expect, inject, onTestFinished, test } from "vite-plus/test";

import { launchDashboardBrowser, newMember, signInAt } from "./dashboard-browser.ts";
import { startSystem } from "./harness.ts";

// The dashboard as browsers reach it through the hub, on both runtimes, the rule that keeps other
// sites from acting with a member's session, and a member's session through Better Auth.

const system = startSystem();
let browser: Browser;

beforeAll(async () => {
  await system.start();
  browser = await launchDashboardBrowser(system);
});
afterAll(async () => {
  await browser?.close();
  await system.stop();
});

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
  const script = await system.hub.fetch(scriptPath);
  expect(script.status).toBe(200);
  expect(script.headers.get("cache-control")?.split(/\s*,\s*/)).toEqual(
    expect.arrayContaining(["max-age=31536000", "immutable"]),
  );

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

test("in a browser, a member signs in, reloads a page, changes the password and signs out", async () => {
  const page = await browser.newPage();
  onTestFinished(() => page.close());
  const dashboard = `${system.origin}/dashboard`;

  // Signed out, a page sends the member to sign in, and back to it once signed in.
  const member = await newMember(system, "Password Reader");
  await signInAt(system, page, "change-password", member);
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
