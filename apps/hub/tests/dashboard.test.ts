import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { type APIRequestContext, request } from "playwright";
import { afterAll, beforeAll, expect, inject, test } from "vite-plus/test";

import { DASHBOARD_ASSETS, DASHBOARD_BASE } from "../src/dashboard.ts";
import { startSystem } from "./harness.ts";

// The dashboard as browsers reach it through the hub, on both runtimes, and the rule that keeps
// other sites from acting with a member's session.

const system = startSystem();
let requests: APIRequestContext;
/** The app shell of the dashboard's build, which global setup builds and both hubs serve. */
let shell: string;
/** The path of one of the build's files under assets, which Vite names by content hash. */
let hashedPath: string;

beforeAll(async () => {
  await system.start();
  requests = await request.newContext({ baseURL: system.url().href });
  // Where the hubs serve the build from, `src/main.ts` and `wrangler.jsonc`.
  const build = path.join(import.meta.dirname, "../../dashboard/dist/client");
  shell = await readFile(path.join(build, "index.html"), "utf8");
  const [hashed] = await readdir(path.join(build, DASHBOARD_ASSETS));
  hashedPath = `${DASHBOARD_BASE}${DASHBOARD_ASSETS}/${hashed}`;
});
afterAll(async () => {
  await requests?.dispose();
  await system.stop();
});

/**
 * Requests `pathname` as a browser's navigation to it, which `Sec-Fetch-Mode: navigate` marks:
 * Cloudflare documents that header as what makes Workers Static Assets serve the app shell for a
 * path with no file, under single-page-application handling. The Node hub serves the shell by path,
 * and a missing file under assets is a 404 whatever the request. Node's `fetch` cannot send it, as
 * it sets `Sec-Fetch-Mode` to the request's mode, which is never `navigate`; Playwright's request
 * API, which needs no browser, sends headers as given. A redirect is not followed, so a shell
 * reached through one fails.
 */
function navigate(pathname: string) {
  return requests.get(pathname, { headers: { "sec-fetch-mode": "navigate" }, maxRedirects: 0 });
}

/** Checks that the hub answers a navigation to `pathname` with the build's app shell, unchanged. */
async function expectShellAt(pathname: string) {
  const response = await navigate(pathname);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toMatch(/^text\/html/);
  expect(await response.text()).toBe(shell);
  return { vary: response.headers().vary };
}

test("dashboard deep links load the shell and caches distinguish missing assets from navigations", async () => {
  await expectShellAt("/dashboard/");
  await expectShellAt("/dashboard/jobs/x");
  // The build's own files stay private: Vite's manifest holds the paths of its sources.
  await expectShellAt("/dashboard/.vite/manifest.json");
  const hashed = await system.hub.fetch(hashedPath);
  expect(hashed.status).toBe(200);
  expect(hashed.headers.get("cache-control")?.split(/\s*,\s*/)).toEqual(
    expect.arrayContaining(["max-age=31536000", "immutable"]),
  );

  // Node's `fetch` sends `Sec-Fetch-Mode: cors`, as a page's `fetch` or module script does.
  const missingPath = "/dashboard/assets/missing.js";
  const missing = await system.hub.fetch(missingPath);
  expect(missing.status).toBe(404);
  expect(missing.headers.get("cache-control") ?? "").not.toContain("immutable");

  if (inject("hub") === "workers") {
    // Cloudflare answers the navigation itself, with the shell (ADR 0043).
    const navigation = await expectShellAt(missingPath);
    for (const vary of [hashed.headers.get("vary"), navigation.vary, missing.headers.get("vary")]) {
      expect(vary?.toLowerCase().split(/\s*,\s*/)).toContain("sec-fetch-mode");
    }
  } else {
    expect((await navigate(missingPath)).status()).toBe(404);
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
