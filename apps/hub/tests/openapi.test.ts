import { compileSchema } from "json-schema-library";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

import { startSystem } from "./harness.ts";

// The hub's OpenAPI document, as callers in other languages and its reference page read it.

const system = startSystem();

beforeAll(() => system.start());
afterAll(() => system.stop());

test("the hub serves its OpenAPI document saying who may call, how errors read and what fields fit", async () => {
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
          security: [{ apiKey: ["job:create"] }, { session: [] }],
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
      // An object in the query string, as `submitter[kind]=member&submitter[id]=…`.
      "/usage": {
        get: {
          parameters: expect.arrayContaining([
            expect.objectContaining({
              name: "submitter",
              style: "deepObject",
              schema: expect.objectContaining({
                properties: expect.objectContaining({
                  kind: { type: "string", enum: ["key", "member"] },
                }),
              }),
            }),
          ]),
        },
      },
    },
  });

  // A call a member may make answers 403 to a signed-in account that is not a member.
  const operations = Object.values<Record<string, { security?: object[]; responses: object }>>(
    document.paths,
  ).flatMap((path) => Object.values(path));
  for (const operation of operations.filter((each) =>
    each.security?.some((scheme) => "session" in scheme),
  )) {
    expect(operation.responses).toHaveProperty("403");
  }

  // An answer may gain fields (ADR 0010), so a client that validates it against the document accepts
  // one it does not know, at the top and nested.
  const added = { addedLater: true };
  const runner = compileSchema({
    $ref: "#/components/schemas/Runner",
    components: document.components,
  });
  expect(
    runner.validate({
      id: "a-runner",
      name: "a-runner",
      registeredAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      connected: true,
      capabilities: {
        runnerVersion: "1.0.0",
        model: { provider: "openai", modelId: "a-model", thinkingLevel: "off", ...added },
        extensions: [],
        ...added,
      },
      ...added,
    }).errors,
  ).toEqual([]);
  // And no answer closes any object it holds, shared schemas included.
  const reached = new Set<object>();
  const reach = (node: unknown): void => {
    if (typeof node !== "object" || node === null || reached.has(node)) return;
    reached.add(node);
    if ("$ref" in node && typeof node.$ref === "string") {
      // The document's references all point into `components.schemas`, whose names hold no `/`.
      reach(
        node.$ref
          .split("/")
          .slice(1)
          .reduce((parent, key) => parent[key], document),
      );
    }
    Object.values(node).forEach(reach);
  };
  for (const operation of operations) reach(operation.responses);
  expect(
    [...reached].filter(
      (node) => "additionalProperties" in node && node.additionalProperties === false,
    ),
  ).toEqual([]);
});
