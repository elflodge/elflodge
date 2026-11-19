import { getOpenAPIMeta } from "@orpc/openapi";
import { walkProcedureContractsSync } from "@orpc/server";
import { apiContract } from "contract";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

import { startSystem, submitJob } from "./harness.ts";

// Every API call refuses a parameter it does not define rather than run without it (ADR 0010).
// Checked on each input's top-level object; the batches tests send an unknown field nested in a job.
// The Runner's own calls ignore unknown fields instead, as the Runner protocol does (ADR 0026).

test("every call's input refuses a parameter it does not define", async () => {
  const checks: Promise<void>[] = [];
  walkProcedureContractsSync({ apiContract }, (procedure, path) => {
    for (const schema of procedure["~orpc"].inputSchemas ?? []) {
      // The upload's input is oRPC's request parts: oRPC fills the outer object and `headers` with
      // more than the call reads, so they stay open, and only `params` is the caller's to check.
      const stray =
        getOpenAPIMeta(procedure)?.inputStructure === "detailed"
          ? { params: { strayParameter: 1 } }
          : { strayParameter: 1 };
      checks.push(
        Promise.resolve(schema["~standard"].validate(stray)).then((result) => {
          const messages = (result.issues ?? []).map((issue) => issue.message);
          expect(messages.join("\n"), path.join(".")).toContain('"strayParameter"');
        }),
      );
    }
  });
  await Promise.all(checks);
});

const system = startSystem();

beforeAll(() => system.start());
afterAll(() => system.stop());

function get(path: string) {
  return system.hub.fetch(path, { headers: { cookie: system.ownerCookie() } });
}

async function expectBadParameter(path: string, name: string) {
  const response = await get(path);
  expect(response.status, path).toBe(400);
  expect(response.headers.get("content-type")).toMatch(/^application\/problem\+json/);
  expect(await response.json(), path).toEqual({
    type: "about:blank",
    title: "Bad Request",
    status: 400,
    detail: expect.stringContaining(name),
  });
}

test.each(["/jobs", "/batches", "/usage"])(
  "%s names a bracketed status it cannot use",
  async (path) => {
    await expectBadParameter(`${path}?status[]=failed`, '"status[]"');
    await expectBadParameter(`${path}?status%5B0%5D=failed`, '"status[0]"');
    await expectBadParameter(`${path}?status=cancelled&status[]=failed`, '"status[]"');
  },
);

test("one bare status filters jobs and a repeated status includes either", async () => {
  const job = await submitJob(system.owner(), {
    input: "Wait for a Runner.",
    outputContract: { schema: { type: "integer" } },
  });
  const failed = await get("/jobs?status=failed");
  expect(await failed.json()).toMatchObject({ jobs: [] });
  const either = await get("/jobs?status=failed&status=queued");
  expect(await either.json()).toMatchObject({ jobs: [{ id: job.id }] });
});

test("Batch and usage filters validate each bare status against their own statuses", async () => {
  await expectBadParameter("/batches?status=failed", "status[0]");
  await expectBadParameter("/batches?status=failed&status=queued", "status[1]");
  await expectBadParameter("/usage?status=failed&status=queued", "status[1]");
  expect((await get("/usage?status=failed")).status).toBe(200);
});
