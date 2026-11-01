import { HTTPException } from "hono/http-exception";
import { expect, test } from "vite-plus/test";

import { createApp } from "../src/app.ts";

// Failures outside oRPC answer as the API does, as Problem Details (ADR 0023): the hub refusing every
// request while its settings are missing, and an error nothing expected.

function appFailingWith(error: Error) {
  return createApp({
    run: async () => {
      throw error;
    },
    acceptRunner: async () => {
      throw error;
    },
  });
}

test("a hub that cannot serve answers 503 as Problem Details", async () => {
  const response = await appFailingWith(new HTTPException(503)).request("/jobs");
  expect(response.status).toBe(503);
  expect(response.headers.get("content-type")).toMatch(/^application\/problem\+json/);
  expect(await response.json()).toMatchObject({ type: "about:blank", status: 503 });
});

test("an unexpected error answers 500 as Problem Details, without its message", async () => {
  const response = await appFailingWith(new Error("secret internals")).request("/jobs");
  expect(response.status).toBe(500);
  expect(response.headers.get("content-type")).toMatch(/^application\/problem\+json/);
  const body = await response.text();
  expect(JSON.parse(body)).toMatchObject({ type: "about:blank", status: 500 });
  expect(body).not.toContain("secret internals");
});
