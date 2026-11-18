import { afterAll, beforeAll, expect, test } from "vite-plus/test";

import { startSystem } from "./harness.ts";

// The hub's OpenAPI document, as callers in other languages and its reference page read it.

const system = startSystem();

beforeAll(() => system.start());
afterAll(() => system.stop());

test("the hub serves its OpenAPI document saying who may call and how errors read", async () => {
  const response = await system.hub.fetch("/spec.json");
  expect(response.status).toBe(200);
  const document = JSON.parse(await response.text());

  expect(document).toMatchObject({
    components: {
      // The shared schemas by name, as readers and the reference page show them.
      schemas: {
        Job: {},
        ProblemDetails: {
          properties: { type: {}, title: {}, status: {}, detail: {} },
          required: ["type", "title", "status"],
        },
        // A body refuses fields the call does not define, which a generated client can check first.
        JobSubmission: { additionalProperties: false },
      },
      securitySchemes: {
        // A call lists the permissions a key needs as role names, which only the description explains.
        apiKey: {
          type: "apiKey",
          in: "header",
          name: "x-api-key",
          description: expect.stringContaining("`resource:action`"),
        },
        // Better Auth's name for the harness's hub, which is not served over HTTPS.
        session: { type: "apiKey", in: "cookie", name: "better-auth.session_token" },
      },
    },
    paths: {
      "/jobs/{id}/cancel": {
        post: {
          responses: {
            200: {
              content: { "application/json": { schema: { $ref: "#/components/schemas/Job" } } },
            },
          },
        },
      },
      "/batches/{id}/jobs": {
        post: {
          security: [{ apiKey: ["job:create"] }],
          responses: {
            401: {
              content: {
                "application/problem+json; charset=utf-8": {
                  schema: { $ref: "#/components/schemas/ProblemDetails" },
                },
              },
            },
          },
        },
      },
      "/jobs/{id}": { get: { security: [{ apiKey: ["job:read"] }, { session: [] }] } },
      "/runners": { get: { security: [{ session: [] }] } },
    },
  });

  // An answer may gain fields, so a client generated from the document must accept unknown ones.
  expect(document.components.schemas.Runner).not.toHaveProperty("additionalProperties");

  // A call a member may make answers 403 to a signed-in account that is not a member.
  const operations = Object.values<Record<string, { security?: object[]; responses: object }>>(
    document.paths,
  ).flatMap((path) => Object.values(path));
  for (const operation of operations.filter((each) =>
    each.security?.some((scheme) => "session" in scheme),
  )) {
    expect(operation.responses).toHaveProperty("403");
  }
});
