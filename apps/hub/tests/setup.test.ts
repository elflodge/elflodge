import { afterAll, beforeAll, expect, inject, test } from "vite-plus/test";

import { DB_SCHEMA, openDatabase } from "../src/db/database.ts";
import { setUpOrganization } from "../src/setup.ts";
import { clearDatabase, startSystem } from "./harness.ts";
import { NEW_OWNER, SETUP, newSetupLink, setupLink } from "./setup-link.ts";

// Setting up a new hub: the link it prints, and creating its owner in the dashboard with it. Each
// test starts from a hub without an Organization.

const system = startSystem();
beforeAll(() => system.start());
afterAll(() => system.stop());

test("a hub without an owner prints a link, with which the dashboard creates the owner once", async () => {
  const { token } = await setupLink(system);
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
  const cookie = await system.signIn(NEW_OWNER);
  const session = await system.hub.fetch("/api/auth/get-session", { headers: { cookie } });
  expect(await session.json()).toMatchObject({
    user: { name: SETUP.name },
    membership: {
      status: "member",
      organization: { id: expect.any(String), name: SETUP.organizationName },
      role: "owner",
    },
  });
  await expect(anyone.setup.complete({ token, ...SETUP })).rejects.toMatchObject({
    code: "CONFLICT",
  });
});

test("a token the hub did not print is refused, and creates nothing", async () => {
  await setupLink(system);
  const anyone = system.client();

  await expect(
    anyone.setup.complete({ token: "not-the-printed-token", ...SETUP }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(await anyone.setup.get()).toEqual({ needed: true });
});

test("a new link replaces the one printed before", async () => {
  const old = await setupLink(system);
  const { token } = await newSetupLink(system);
  const anyone = system.client();

  await expect(anyone.setup.complete({ token: old.token, ...SETUP })).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await anyone.setup.complete({ token, ...SETUP });
});

test("a password Better Auth refuses leaves the link usable", async () => {
  const { token } = await setupLink(system);
  const anyone = system.client();

  await expect(anyone.setup.complete({ token, ...SETUP, password: "short" })).rejects.toMatchObject(
    { code: "BAD_REQUEST" },
  );

  await anyone.setup.complete({ token, ...SETUP });
  await system.signIn(NEW_OWNER);
});

test("of two setups at once, one creates the owner and the other finds the hub set up", async () => {
  // As from two tabs with the same link.
  const { token } = await setupLink(system);
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
      canPrintSetupLink: false,
    }),
  ).rejects.toThrow("Set both ADMIN_EMAIL and ADMIN_PASSWORD");
});
