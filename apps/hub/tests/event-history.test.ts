import type { JobEvent } from "contract";
import { afterAll, assert, beforeAll, expect, test } from "vite-plus/test";

import { protocolClient, startedJobReport, startSystem, submitJob } from "./harness.ts";

const system = startSystem();

beforeAll(() => system.start());
afterAll(() => system.stop());

function conversation(id: number): JobEvent {
  return { id, type: "conversation", record: {} };
}

test("a member can walk back from the newest event and follow new reports from the same position", async ({
  onTestFinished,
}) => {
  const member = system.owner();
  const { id } = await submitJob(member, {
    input: "Count to three.",
    outputContract: { schema: {} },
  });
  const { socket } = await system.connectRunner();
  onTestFinished(() => socket.close(1000));
  const runner = protocolClient(socket);
  const {
    runs: [placed],
  } = await runner.request("sync", { held: [], free: 1 }, 10_000);
  assert(placed?.jobId === id);
  const run = { jobId: id, runId: placed.runId };
  async function report(position: number, events: JobEvent[]) {
    const answer = await runner.request(
      "report",
      {
        held: [run],
        free: 0,
        deleted: [],
        jobs: [{ ...run, intent: "run", position, events }],
      },
      10_000,
    );
    expect(answer.refused).toEqual([]);
  }

  const start = startedJobReport(run);
  await report(0, start.events);
  await report(1, [4, 9, 14].map(conversation));
  // This event alone fills the newest page. Its report has no eligible lines on the next read.
  await report(14, [{ id: 20, type: "conversation", record: { text: "x".repeat(1024 * 1024) } }]);

  // Reading from Start returns its Events even when the job is omitted before the last chunk.
  expect(await member.jobs.events({ id, limit: 1 })).toEqual({
    events: start.events,
    hasMore: true,
  });

  const newest = await member.jobs.events({ id, order: "desc", limit: 2 });
  expect(newest.events.map((event) => event.id)).toEqual([20]);
  expect(newest).toMatchObject({ hasMore: true, job: { status: "running" } });
  const [cursor] = newest.events;
  assert(cursor);
  await report(cursor.id, [26, 32].map(conversation));

  const older = await member.jobs.events({ id, order: "desc", after: cursor.id, limit: 2 });
  expect(older.events.map((event) => event.id)).toEqual([14, 9]);
  expect(older.hasMore).toBe(true);
  const oldestShown = older.events.at(-1);
  assert(oldestShown);
  const first = await member.jobs.events({ id, order: "desc", after: oldestShown.id, limit: 2 });
  expect(first.events.map((event) => event.id)).toEqual([4, 1]);
  expect(first).not.toHaveProperty("job");
  expect(first.hasMore).toBe(false);

  const live = await member.jobs.events({ id, after: cursor.id });
  expect(live.events.map((event) => event.id)).toEqual([26, 32]);
  expect(live.hasMore).toBe(false);
});
