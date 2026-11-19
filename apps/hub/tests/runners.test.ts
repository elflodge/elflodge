import { hostname } from "node:os";

import { Effect } from "effect";
import { afterAll, assert, afterEach, beforeAll, expect, test } from "vite-plus/test";

import { protocolClient, startSystem } from "./harness.ts";

const system = startSystem();

beforeAll(() => system.start());
afterEach(() => system.stopRunner());
afterAll(() => system.stop());

test("the hub lists no runners before any connect", async () => {
  expect(await system.owner().runners.list()).toEqual([]);
});

test("a runner that connects is listed under its host's name with its capabilities, connected and seen when it said hello", async () => {
  const before = Date.now();
  const runnerId = await system.startRunner();

  await expect
    .poll(() => system.findRunner(runnerId))
    .toEqual({
      id: runnerId,
      name: hostname(),
      registeredAt: expect.any(Date),
      lastSeenAt: expect.any(Date),
      connected: true,
      capabilities: {
        runnerVersion: expect.any(String),
        model: { provider: expect.any(String), modelId: expect.any(String), thinkingLevel: "off" },
        extensions: [],
        webSearch: { enabled: false },
      },
    });
  expect(await system.lastSeen(runnerId)).toBeGreaterThanOrEqual(before);
  expect((await system.findRunner(runnerId))?.registeredAt.getTime()).toBeGreaterThanOrEqual(
    before,
  );
});

test("a runner that restarts keeps its identity, listed once and seen again", async () => {
  async function startAndWaitForHello() {
    const ready = Promise.withResolvers<void>();
    const id = await system.startRunner({ onReady: Effect.sync(ready.resolve) });
    await ready.promise;
    return id;
  }
  const runnerId = await startAndWaitForHello();
  const before = await system.owner().runners.list();
  const runner = before.find(({ id }) => id === runnerId);
  assert(runner, "The hub did not list the started Runner");
  const { registeredAt, lastSeenAt } = runner;

  await system.stopRunner();
  expect(await startAndWaitForHello()).toBe(runnerId);

  const listed = await system.owner().runners.list();
  expect(listed).toHaveLength(before.length);
  const matches = listed.filter(({ id }) => id === runnerId);
  expect(matches).toMatchObject([{ name: hostname(), registeredAt }]);
  const [restarted] = matches;
  assert(restarted, "The hub did not list the restarted Runner");
  expect(restarted.lastSeenAt.getTime()).toBeGreaterThan(lastSeenAt.getTime());
});

test("a runner whose capabilities the hub cannot read still connects, listed without it", async () => {
  const { runnerId, socket } = await system.connectRunner();
  const runner = protocolClient(socket);

  await runner.request(
    "hello",
    { name: "newer runner", capabilities: { runnerVersion: 2 } },
    10_000,
  );

  expect(await system.findRunner(runnerId)).toEqual({
    id: runnerId,
    name: "newer runner",
    registeredAt: expect.any(Date),
    lastSeenAt: expect.any(Date),
    connected: true,
    capabilities: null,
  });
  socket.close();
});

test("the hub serves many requests at once", async () => {
  const responses = await Promise.all(
    Array.from({ length: 20 }, () =>
      system.hub.fetch("/runners", { headers: { cookie: system.ownerCookie() } }),
    ),
  );

  expect(responses.map((response) => response.status)).toEqual(Array(20).fill(200));
});

test("a removed runner stops when started again, and joins anew with register", async () => {
  const runnerId = await system.startRunner();
  await system.stopRunner();
  await system.owner().runners.delete({ id: runnerId });

  const removed = new Promise<void>((resolve) => system.startRunner({ onRemoved: resolve }));
  await removed;

  const newRunnerId = await system.startRunner({ register: true });
  expect(newRunnerId).not.toBe(runnerId);
  await expect.poll(() => system.findRunner(newRunnerId)).toBeDefined();
});

test("a runner offering no protocol version the hub supports is refused, told which it supports", async () => {
  const registration = system.runnerClient({
    "x-api-key": await system.createRegistrationKey(),
  });
  const { key } = await registration.register({ name: "old runner" });

  const answer = await system.connect(key, ["elflodge.v0"]);

  expect(answer.status).toBe(400);
  expect(await answer.json()).toMatchObject({
    code: "protocolUnsupported",
    supported: ["elflodge.v1"],
  });
});
