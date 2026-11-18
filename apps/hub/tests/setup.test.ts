import { afterAll, beforeAll, expect, inject, test } from "vite-plus/test";

import { setUpOrganization } from "../src/setup.ts";
import { clearDatabase, startSystem } from "./harness.ts";

// Setting up a new hub: the link it prints, and creating its owner in the dashboard with it. Each
// test starts from a hub without an Organization.

const system = startSystem();
beforeAll(() => system.start());
afterAll(() => system.stop());

const NEW_OWNER = { email: "new-owner@example.com", password: "a long enough password" };

/** Empties the hub's database and sets it up as a hub without owner settings does: its link. */
async function setupLink() {
  await clearDatabase(inject("databaseUrl"));
  const messages: string[] = [];
  await setUpOrganization(inject("databaseUrl"), { owner: {}, hubUrl: system.origin }, (message) =>
    messages.push(message),
  );
  const link = new URL(messages.join("\n").split("\n").at(-1) ?? "");
  expect(link.origin + link.pathname).toBe(`${system.origin}/dashboard/setup`);
  return { link, token: link.hash.slice(1) };
}

test("a hub without an owner prints a link, with which the dashboard creates the owner once", async () => {
  const { token } = await setupLink();
  const anyone = system.client();
  expect(await anyone.setup.get()).toEqual({ needed: true });

  await anyone.setup.complete({ token, ...NEW_OWNER });

  expect(await anyone.setup.get()).toEqual({ needed: false });
  const owner = system.client({ cookie: await system.signIn(NEW_OWNER), origin: system.origin });
  expect(await owner.runners.list()).toEqual([]);
  await expect(anyone.setup.complete({ token, ...NEW_OWNER })).rejects.toMatchObject({
    code: "CONFLICT",
  });
});

test("a token the hub did not print is refused, and creates nothing", async () => {
  await setupLink();
  const anyone = system.client();

  await expect(
    anyone.setup.complete({ token: "not-the-printed-token", ...NEW_OWNER }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(await anyone.setup.get()).toEqual({ needed: true });
});

test("a password Better Auth refuses leaves the link usable", async () => {
  const { token } = await setupLink();
  const anyone = system.client();

  await expect(
    anyone.setup.complete({ token, email: NEW_OWNER.email, password: "short" }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });

  await anyone.setup.complete({ token, ...NEW_OWNER });
  await system.signIn(NEW_OWNER);
});

test("of two setups at once, one creates the owner and the other finds the hub set up", async () => {
  const first = await setupLink();
  const second = new URL(
    await new Promise<string>(
      (resolve) =>
        void setUpOrganization(
          inject("databaseUrl"),
          { owner: {}, hubUrl: system.origin },
          (message) => resolve(message.split("\n").at(-1) ?? ""),
        ),
    ),
  ).hash.slice(1);
  const anyone = system.client();

  const results = await Promise.allSettled([
    anyone.setup.complete({ token: first.token, ...NEW_OWNER }),
    anyone.setup.complete({
      token: second,
      email: "other@example.com",
      password: NEW_OWNER.password,
    }),
  ]);

  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.find((result) => result.status === "rejected")?.reason).toMatchObject({
    code: "CONFLICT",
  });
});

test("only one of the owner's settings is refused", async () => {
  await clearDatabase(inject("databaseUrl"));

  await expect(
    setUpOrganization(inject("databaseUrl"), {
      owner: { email: NEW_OWNER.email },
      hubUrl: system.origin,
    }),
  ).rejects.toThrow("Set both ADMIN_EMAIL and ADMIN_PASSWORD");
});
