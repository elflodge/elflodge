import type { RequestListener } from "node:http";
import { text } from "node:stream/consumers";

import { expect, test } from "vite-plus/test";
import * as z from "zod/mini";

import { runCli } from "./run-cli.ts";

// `jobs submit` creates a Batch of one and adds its job under one ID, and retries a call that got no
// answer with that ID, so the hub accepts the Batch and the job at most once; the hub's own tests
// check that one ID makes one Batch and one job.

test("jobs submit retries the Batch and its job under one ID and prints that ID if no answer arrives", async () => {
  const created: string[] = [];
  const added: unknown[] = [];
  const hub: RequestListener = async (request) => {
    expect(request.url).toBe("/batches");
    const { id, jobs } = z.parse(
      z.object({ id: z.string(), jobs: z.array(z.object({ customId: z.string() })) }),
      JSON.parse(await text(request)),
    );
    created.push(id);
    added.push(...jobs.map((job) => job.customId));
    request.socket.destroy();
  };
  const { exitCode, stderr } = await runCli(
    [
      "jobs",
      "submit",
      "--json",
      JSON.stringify({
        agent: { outputContract: { schema: { type: "integer" } } },
        input: "Count to ten.",
      }),
    ],
    { hub },
  );

  expect(created).toHaveLength(3);
  expect(added).toHaveLength(3);
  expect(new Set([...created, ...added]).size).toBe(1);
  expect(exitCode).toBe(1);
  expect(stderr).toContain(`The job's custom ID is ${created[0]}`);
});

test("jobs submit prints the generated ID for recovery when the hub's answer fails output validation", async () => {
  const receivedIds: string[] = [];
  const hub: RequestListener = async (request, response) => {
    const { id } = z.parse(z.object({ id: z.string() }), JSON.parse(await text(request)));
    receivedIds.push(id);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id }));
  };
  const { exitCode, stderr } = await runCli(
    [
      "jobs",
      "submit",
      "--json",
      JSON.stringify({ agent: { outputContract: { schema: {} } }, input: "Count." }),
    ],
    { hub },
  );

  expect(receivedIds).toHaveLength(1);
  expect(exitCode).toBe(1);
  expect(stderr).toContain("Output validation failed");
  expect(stderr).toContain(`The job's custom ID is ${receivedIds[0]}`);
});
