import { RUNNER_NOT_FOUND } from "contract";
import { afterAll, beforeAll, expect, inject, test } from "vite-plus/test";

import { DB_SCHEMA, openDatabase } from "../src/db/database.ts";
import { ApikeyId, type ApikeyUpdate } from "../src/db/types.ts";
import { resetPassword, setUpOrganization } from "../src/setup.ts";
import { OWNER, startSystem } from "./harness.ts";

const system = startSystem();

beforeAll(() => system.start());
afterAll(() => system.stop());

test("calls without a member's session or a key are refused, and told how to authenticate", async () => {
  for (const path of ["/runners", "/api-keys"]) {
    expect((await system.hub.fetch(path)).status).toBe(401);
  }
  const write = await system.hub.fetch("/batches/x/pause", { method: "POST" });
  expect(write.status).toBe(401);
  expect(write.headers.get("www-authenticate")).not.toBeNull();
  // `defined`: the contract declares the error, so the TypeScript client's errors stay typed.
  await expect(system.runnerClient().register({ name: "host" })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
    defined: true,
  });
  expect((await system.connect()).status).toBe(401);
});

test("a call sent with a key is decided by the key, whatever session it carries", async () => {
  const id = crypto.randomUUID();
  const member = system.client({ cookie: system.ownerCookie() });
  await expect(member.jobs.get({ id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  const memberWithUnknownKey = system.client({
    cookie: system.ownerCookie(),
    "x-api-key": "not-a-key",
  });
  await expect(memberWithUnknownKey.jobs.get({ id })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
});

test("API errors are RFC 9457 Problem Details", async () => {
  const refused = await system.hub.fetch("/runners");
  expect(refused.headers.get("content-type")).toMatch(/^application\/problem\+json/);
  expect(await refused.json()).toEqual({ type: "about:blank", title: "Unauthorized", status: 401 });

  const missing = await system.hub.fetch("/no-such-path");
  expect(missing.headers.get("content-type")).toMatch(/^application\/problem\+json/);
  expect(await missing.json()).toEqual({ type: "about:blank", title: "Not Found", status: 404 });

  // Invalid input names its problems, so a caller can correct the request.
  const { key } = await system.owner().apiKeys.create({
    name: "invalid input",
    permissions: { runner: ["register"] },
  });
  const invalid = await system.hub.fetch("/runners/register", {
    method: "POST",
    headers: { "x-api-key": key, "content-type": "application/json" },
    body: "{}",
  });
  expect(await invalid.json()).toEqual({
    type: "about:blank",
    title: "Bad Request",
    status: 400,
    detail: expect.stringContaining("name"),
    errors: [{ pointer: "/name", detail: expect.any(String) }],
  });
});

test("a member removed from the Organization is refused, though their session lasts", async () => {
  const email = "removed@example.com";
  const { client: asMember, cookie } = await system.addMember({ email, name: "Removed" });
  await asMember.runners.list();
  const getSession = async () => {
    const response = await system.hub.fetch("/api/auth/get-session", { headers: { cookie } });
    return response.json();
  };
  expect(await getSession()).toMatchObject({ membership: { status: "member" } });
  // The owner manages the Organization through Better Auth's organization routes on the hub.
  const ownerAuth = system.ownerAuth();
  const [organization] = await ownerAuth.organization.list();
  if (!organization) throw new Error("The hub has no Organization");

  await ownerAuth.organization.removeMember({
    memberIdOrEmail: email,
    organizationId: organization.id,
  });

  const after = await getSession();
  expect(after).toHaveProperty("user.email", email);
  expect(after).toHaveProperty("membership", { status: "notMember" });

  // Signing in again would not help, so the refusal is not a 401.
  await expect(asMember.runners.list()).rejects.toMatchObject({
    code: "FORBIDDEN",
    defined: true,
    message: "This account is not a member of the Organization",
  });
});

test("key management refusals tell a member which permission their role needs", async () => {
  const { client: member } = await system.addMember({
    email: "member@example.com",
    name: "Member",
  });
  await expect(member.apiKeys.list()).rejects.toMatchObject({
    cause: { status: 403, detail: expect.stringContaining("apiKey:read") },
  });
  await expect(member.runners.delete({ id: crypto.randomUUID() })).rejects.toMatchObject({
    cause: { status: 403, detail: expect.stringContaining("apiKey:delete") },
  });
});

test("a member creates and lists keys, and a revoked key is refused at once", async () => {
  const owner = system.owner();
  const { id, key } = await owner.apiKeys.create({
    name: "CI",
    permissions: { runner: ["register"] },
  });

  const listed = await owner.apiKeys.list();
  expect(listed).toContainEqual(
    expect.objectContaining({ id, name: "CI", permissions: { runner: ["register"] } }),
  );
  // Only the key's first characters are listed; its value is shown once, when it is created.
  expect(JSON.stringify(listed)).not.toContain(key);

  const withKey = system.runnerClient({ "x-api-key": key });
  await expect(withKey.register({ name: "host" })).resolves.toMatchObject({
    id: expect.any(String),
  });
  await owner.apiKeys.revoke({ id });
  await expect(withKey.register({ name: "host" })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
});

test("a member who revokes a key still gets the renewed session cookie from get-session", async () => {
  const cookie = await system.signIn(OWNER);
  const owner = system.client({ cookie, origin: system.origin });
  const { id } = await owner.apiKeys.create({ name: "CI", permissions: { runner: ["register"] } });
  await system.makeSessionDueForRenewal(cookie);

  await owner.apiKeys.revoke({ id });
  const response = await system.hub.fetch("/api/auth/get-session", { headers: { cookie } });
  expect(response.headers.get("set-cookie")).toContain("session_token=");
});

test("a member can list every live service key in an Organization with over 100 keys", async () => {
  const owner = system.owner();
  const registration = await system.createRegistrationKey();
  const expectedIds = (await owner.apiKeys.list()).map((key) => key.id);
  await system.runnerClient({ "x-api-key": registration }).register({ name: "host" });

  const create = (name: string) =>
    owner.apiKeys.create({ name, permissions: { runner: ["read"] } });
  for (let i = 0; i < 100; i++) {
    const { id } = await create(`service ${i}`);
    expectedIds.push(id);
  }
  const expired = await create("expired");
  // The hub has no call to move a key's expiry into the past.
  await using database = openDatabase(inject("databaseUrl"));
  await database
    .withSchema(DB_SCHEMA)
    .updateTable("apikey")
    .set({ expiresAt: new Date(0) } satisfies ApikeyUpdate)
    .where("id", "=", ApikeyId(expired.id))
    .execute();

  const listed = await owner.apiKeys.list();
  expect(listed.map((key) => key.id).toSorted()).toEqual(expectedIds.toSorted());
}, 30_000);

test("a key cannot reach member operations or permissions it was not granted", async () => {
  const registrationKey = await system.createRegistrationKey();
  const withRegistrationKey = system.client({ "x-api-key": registrationKey });
  // Only signed-in members manage keys.
  await expect(withRegistrationKey.apiKeys.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    withRegistrationKey.apiKeys.create({ name: "escalated", permissions: { apiKey: ["create"] } }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(withRegistrationKey.runners.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });

  // A registration key may register Runners. Only a Runner's own key may connect as that Runner.
  // Better Auth refuses a key without the permission as it refuses an unknown key.
  const { key: runnerKey } = await system
    .runnerClient({ "x-api-key": registrationKey })
    .register({ name: "host" });
  expect((await system.connect(registrationKey)).status).toBe(401);
  await expect(
    system.runnerClient({ "x-api-key": runnerKey }).register({ name: "host" }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

test("a Runner read key lists Runners and cannot register or remove one or read jobs", async () => {
  const registered = await system
    .runnerClient({
      "x-api-key": await system.createRegistrationKey(),
    })
    .register({ name: "listed host" });
  const { key } = await system.owner().apiKeys.create({
    name: "Runner listing",
    permissions: { runner: ["read"] },
  });
  const headers = { "x-api-key": key };
  const reader = system.client(headers);
  expect(await reader.runners.list()).toContainEqual(
    expect.objectContaining({ id: registered.id }),
  );
  await expect(reader.runners.delete({ id: registered.id })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(
    system.runnerClient(headers).register({ name: "another host" }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(reader.jobs.get({ id: crypto.randomUUID() })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
});

test("removing a Runner refuses its key and takes it off the list", async () => {
  // The hub also closes the Runner's socket at once (code 1008). Local workerd completes that close
  // only about 10 s later, for every client tried, so the test checks what takes effect at once.
  const { runnerId, key, socket } = await system.connectRunner();

  await system.owner().runners.delete({ id: runnerId });

  expect(await system.findRunner(runnerId)).toBeUndefined();
  const reconnect = await system.connect(key);
  expect(reconnect.status).toBe(401);
  expect(await reconnect.json()).toMatchObject({ status: 401, code: RUNNER_NOT_FOUND });
  socket.close(1000);
});

test("a name over the key limit locates the submitted name", async () => {
  await expect(
    system.owner().apiKeys.create({ name: "🌲".repeat(17), permissions: { job: ["read"] } }),
  ).rejects.toMatchObject({
    cause: { status: 400, errors: [{ pointer: "/name", detail: expect.any(String) }] },
    data: { issues: [{ path: ["name"], message: expect.any(String) }] },
  });
});

test("a key can be created to expire, within Better Auth's limits of a day to a year", async () => {
  const owner = system.owner();
  const day = 24 * 60 * 60;
  const { id } = await owner.apiKeys.create({
    name: "one batch of hosts",
    permissions: { runner: ["register"] },
    expiresIn: day,
  });

  const listed = (await owner.apiKeys.list()).find((key) => key.id === id);
  expect(listed?.expiresAt?.getTime()).toBeGreaterThan(Date.now() + day * 1000 - 60_000);
  await expect(
    owner.apiKeys.create({
      name: "too short",
      permissions: { runner: ["register"] },
      expiresIn: 60,
    }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("members cannot grant a key member permissions or a Runner's own permission", async () => {
  const tooMuch: Record<string, string[]>[] = [{ apiKey: ["create"] }, { runner: ["actAs"] }];
  for (const permissions of tooMuch) {
    await expect(
      system.owner().apiKeys.create({ name: "too much", permissions }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  }
});

test("setting up again leaves the existing Organization and owner as they are", async () => {
  const messages: string[] = [];
  await setUpOrganization(
    inject("databaseUrl"),
    {
      owner: { email: "someone-else@example.com", password: "another password" },
      hubUrl: system.origin,
      canPrintSetupLink: false,
    },
    (message) => messages.push(message),
  );

  expect(messages).toEqual([
    "The Organization exists, so ADMIN_EMAIL and ADMIN_PASSWORD are ignored",
  ]);
  await system.signIn(OWNER);
});

test("a forgotten password is reset with the recovery command, signing out old sessions", async () => {
  const oldSession = await system.signIn(OWNER);
  const password = "a brand new password";
  await resetPassword(inject("databaseUrl"), { email: OWNER.email, password });

  expect((await system.hub.fetch("/runners", { headers: { cookie: oldSession } })).status).toBe(
    401,
  );

  await system.signIn({ email: OWNER.email, password });
  const oldPassword = await system.hub.fetch("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: system.origin },
    body: JSON.stringify(OWNER),
  });
  expect(oldPassword.status).toBe(401);
});
