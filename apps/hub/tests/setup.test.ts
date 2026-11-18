import { afterAll, beforeAll, expect, inject, test } from "vite-plus/test";

import { DB_SCHEMA, openDatabase } from "../src/db/database.ts";
import { setUpOrganization } from "../src/setup.ts";
import { clearDatabase, startSystem } from "./harness.ts";

// Setting up a new hub: the link it prints, and creating its owner in the dashboard with it. Each
// test starts from a hub without an Organization.

const system = startSystem();
beforeAll(() => system.start());
afterAll(() => system.stop());

const NEW_OWNER = { email: "new-owner@example.com", password: "a long enough password" };
/** What the setup form sends, apart from the token. */
const SETUP = { organizationName: "Harbor & Pine", ...NEW_OWNER };

/** Empties the hub's database and sets it up as a hub without owner settings does: its link. */
async function setupLink() {
  await clearDatabase(inject("databaseUrl"));
  return newSetupLink();
}

/** Sets the hub up again without owner settings, which prints a new link. */
async function newSetupLink() {
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
  // The database keeps the token only by its digest, so reading it gives no working link.
  {
    await using db = openDatabase(inject("databaseUrl"));
    const rows = await db.withSchema(DB_SCHEMA).selectFrom("verification").selectAll().execute();
    expect(JSON.stringify(rows)).not.toContain(token);
  }

  await anyone.setup.complete({ token, ...SETUP });

  expect(await anyone.setup.get()).toEqual({ needed: false });
  const owner = system.client({ cookie: await system.signIn(NEW_OWNER), origin: system.origin });
  expect(await owner.organization.get()).toEqual({ name: SETUP.organizationName });
  await expect(anyone.setup.complete({ token, ...SETUP })).rejects.toMatchObject({
    code: "CONFLICT",
  });
});

test("a token the hub did not print is refused, and creates nothing", async () => {
  await setupLink();
  const anyone = system.client();

  await expect(
    anyone.setup.complete({ token: "not-the-printed-token", ...SETUP }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(await anyone.setup.get()).toEqual({ needed: true });
});

test("a new link replaces the one printed before", async () => {
  const old = await setupLink();
  const { token } = await newSetupLink();
  const anyone = system.client();

  await expect(anyone.setup.complete({ token: old.token, ...SETUP })).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await anyone.setup.complete({ token, ...SETUP });
});

test("a password Better Auth refuses leaves the link usable", async () => {
  const { token } = await setupLink();
  const anyone = system.client();

  await expect(anyone.setup.complete({ token, ...SETUP, password: "short" })).rejects.toMatchObject(
    { code: "BAD_REQUEST" },
  );

  await anyone.setup.complete({ token, ...SETUP });
  await system.signIn(NEW_OWNER);
});

test("of two setups at once, one creates the owner and the other finds the hub set up", async () => {
  // As from two tabs with the same link.
  const { token } = await setupLink();
  const anyone = system.client();

  const results = await Promise.allSettled([
    anyone.setup.complete({ token, ...SETUP }),
    anyone.setup.complete({ token, ...SETUP, email: "other@example.com" }),
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
