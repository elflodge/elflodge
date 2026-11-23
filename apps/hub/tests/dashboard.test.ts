import { parse } from "node-html-parser";
import { request } from "undici";
import { afterAll, beforeAll, expect, inject, test } from "vite-plus/test";

import { startSystem } from "./harness.ts";

// The dashboard as browsers reach it through the hub, on both runtimes, and the rule that keeps
// other sites from acting with a member's session.

const system = startSystem();

beforeAll(() => system.start());
afterAll(() => system.stop());

/**
 * Requests `pathname` as a browser's navigation to it. `Sec-Fetch-Mode: navigate` is what makes it
 * one: Cloudflare documents that header as what Workers Static Assets serve the app shell for under
 * single-page-application handling, where the Node hub serves it for any GET; the other headers are
 * what Chromium sends with it. Node's `fetch` replaces that header with its own mode, never
 * `navigate`, so this goes through undici's `request`, which sends headers as given.
 */
async function navigate(pathname: string) {
  const response = await request(new URL(pathname, system.url()), {
    headers: {
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  return {
    status: response.statusCode,
    headers: response.headers,
    html: await response.body.text(),
  };
}

/** Checks that the hub answers a navigation to `pathname` with the app shell, and returns its script. */
async function expectShellAt(pathname: string) {
  const { status, headers, html } = await navigate(pathname);
  expect(status).toBe(200);
  expect(headers["content-type"]).toMatch(/^text\/html/);
  const scriptPath = parse(html)
    .querySelector('script[src^="/dashboard/assets/"][src$=".js"]')
    ?.getAttribute("src");
  if (!scriptPath) throw new Error(`No dashboard script in the shell at ${pathname}`);
  return scriptPath;
}

test("dashboard deep links load the shell and caches distinguish missing assets from navigations", async () => {
  await expectShellAt("/dashboard/");
  await expectShellAt("/dashboard/jobs/x");
  // The build's own files stay private: Vite's manifest holds the paths of its sources.
  const scriptPath = await expectShellAt("/dashboard/.vite/manifest.json");
  const script = await system.hub.fetch(scriptPath);
  expect(script.status).toBe(200);
  expect(script.headers.get("cache-control")?.split(/\s*,\s*/)).toEqual(
    expect.arrayContaining(["max-age=31536000", "immutable"]),
  );

  // Node's `fetch` sends `Sec-Fetch-Mode: cors`, as a page's `fetch` or module script does.
  const missingPath = "/dashboard/assets/missing.js";
  const missing = await system.hub.fetch(missingPath);
  expect(missing.status).toBe(404);
  expect(missing.headers.get("cache-control") ?? "").not.toContain("immutable");

  const navigation = await navigate(missingPath);
  if (inject("hub") === "workers") {
    // undici gives a header sent on several lines as an array, which `String` joins with commas.
    const navigationVary = String(navigation.headers.vary);
    for (const vary of [script.headers.get("vary"), navigationVary, missing.headers.get("vary")]) {
      expect(vary?.toLowerCase().split(/\s*,\s*/)).toContain("sec-fetch-mode");
    }
  } else {
    expect(navigation.status).toBe(404);
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
