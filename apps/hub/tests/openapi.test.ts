import { resolveJsonSchemaLocalPointer, type JsonSchema } from "@orpc/json-schema";
import type { OpenAPIV3_2 } from "@orpc/openapi";
import { compileSchema } from "json-schema-library";
import { afterAll, assert, beforeAll, expect, test } from "vite-plus/test";

import { startSystem } from "./harness.ts";

// The hub's OpenAPI document, as callers in other languages read it.

const system = startSystem();

beforeAll(() => system.start());
afterAll(() => system.stop());

test("the hub serves its OpenAPI document saying who may call, how errors read and what fields fit", async () => {
  const response = await system.hub.fetch("/spec.json");
  expect(response.status).toBe(200);
  const document = JSON.parse(await response.text());

  expect(document).toMatchObject({
    components: {
      // Clients can look up shared schemas by name.
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
      "/jobs/counts": { get: { responses: { 400: {} } } },
      "/setup": { post: { responses: { 422: {} } } },
      "/jobs/{id}": { get: { security: [{ apiKey: ["job:read"] }, { session: [] }] } },
      "/runners": { get: { security: [{ apiKey: ["runner:read"] }, { session: [] }] } },
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

  const operations = Object.values<OpenAPIV3_2.PathItemObject>(document.paths).flatMap((path) =>
    [
      path.get,
      path.put,
      path.post,
      path.delete,
      path.options,
      path.head,
      path.patch,
      path.trace,
      path.query,
      ...Object.values(path.additionalOperations ?? {}),
    ].filter((operation) => operation !== undefined),
  );

  // A call a member may make answers 403 to a signed-in account that is not a member.
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
  const schemas = new Map<JsonSchema, string>();
  for (const operation of operations) {
    for (const [status, definition] of Object.entries(operation.responses ?? {})) {
      if (status.startsWith("x-")) continue;
      // The generator inlines responses and media types. A reference here would hide their schemas.
      const responseLocation = `${operation.operationId} response ${status}`;
      expect(definition, responseLocation).not.toHaveProperty("$ref");
      for (const [type, media] of Object.entries<OpenAPIV3_2.MediaTypeObject>(
        definition.content ?? {},
      )) {
        const location = `${responseLocation} ${type}`;
        expect(media, location).not.toHaveProperty("$ref");
        if (media.schema !== undefined) schemas.set(media.schema, location);
      }
    }
  }
  // toSchemaNodes visits inline subschemas. Shared schemas live elsewhere in the OpenAPI document,
  // so follow their references from each response and check each target once.
  for (const [schema, location] of schemas) {
    for (const node of compileSchema(schema).toSchemaNodes()) {
      expect(node.schema.additionalProperties, `${location} ${node.schemaLocation}`).not.toBe(
        false,
      );
      if (node.$ref) {
        const target = resolveJsonSchemaLocalPointer(document, node.$ref);
        assert.isDefined(target, node.$ref);
        schemas.set(target, node.$ref);
      }
    }
  }
});
