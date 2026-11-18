import { type Browser, chromium } from "playwright";
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

/**
 * Checks that the hub answers a browser's navigation to `pathname` with the app shell. Workers Static
 * Assets answer a path with no file of its own with it only for a navigation, by `Sec-Fetch-Mode`.
 */
async function expectShellAt(pathname: string) {
  const page = await browser.newPage();
  onTestFinished(() => page.close());
  const response = await page.goto(`${system.origin}${pathname}`);
  if (!response) throw new Error(`No response for ${pathname}`);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toMatch(/^text\/html/);
  const body = await response.text();
  // The app's script, under the dashboard's base path.
  expect(body).toMatch(/<script[^>]* src="\/dashboard\/assets\/[^"]+\.js"/);
}

test("the dashboard's pages, deep links included, load its app shell", async () => {
  await expectShellAt("/dashboard/");
  await expectShellAt("/dashboard/jobs/x");
  // The build's own files stay private: Vite's manifest holds the paths of its sources.
  await expectShellAt("/dashboard/.vite/manifest.json");
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
  await page.getByText(OWNER.email).waitFor();

  await page.reload();
  const heading = page.getByRole("heading", { name: "Change password" });
  await heading.waitFor();

  const password = "a new password for the owner";
  await page.getByLabel("Current password").fill(OWNER.password);
  await page.getByLabel("New password", { exact: true }).fill(password);
  await page.getByLabel("Confirm new password").fill(password);
  await page.getByRole("button", { name: "Change password" }).click();
  await page.getByRole("status").waitFor();

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(`${dashboard}/sign-in`);
  // The new password signs in.
  await system.signIn({ email: OWNER.email, password });
}, 30_000);

// Last, as it empties the hub.
test("in a browser, the setup link creates the owner, who is then signed in", async () => {
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
  await page.getByLabel("Email").fill(owner.email);
  await page.getByLabel("Password").fill(owner.password);
  await page.getByRole("button", { name: "Create owner" }).click();
  await page.waitForURL(`${dashboard}/`);
  await page.getByText(owner.email).waitFor();
}, 30_000);
