import { sql } from "kysely";
import { afterAll, beforeAll, expect, inject, test } from "vite-plus/test";

import { openDatabase } from "../src/db/database.ts";
import { OWNER, startSystem } from "./harness.ts";

const system = startSystem();
let organizationId: string;

beforeAll(async () => {
  await system.start();
  const [organization] = await system.ownerAuth().organization.list();
  if (!organization) throw new Error("The hub has no Organization");
  organizationId = organization.id;
});
afterAll(() => system.stop());

const password = "the invited person's password";

function invite(
  email: string,
  role: "admin" | "member" | "owner" | ("owner" | "admin")[],
  cookie = system.ownerCookie(),
) {
  return system.authClient(cookie).organization.inviteMember({ email, role, organizationId });
}

async function memberId(email: string) {
  const { members } = await system
    .ownerAuth()
    .organization.listMembers({ query: { organizationId } });
  const member = members.find((row) => row.user.email === email);
  if (!member) throw new Error("The invited member is missing");
  return member.id;
}

function authPost(path: string, body: object, cookie?: string) {
  return system.hub.fetch(`/api/auth/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: system.origin,
      ...(cookie && { cookie }),
    },
    body: JSON.stringify(body),
  });
}

test("a new account can redeem a live invitation once and sign in with the granted role", async () => {
  const email = "new@example.com";
  const { id: invitationId } = await invite(email, "admin");
  const anyone = system.client().invitations;
  expect(await anyone.preview({ invitationId })).toMatchObject({
    email,
    role: "admin",
    organizationName: "Organization",
    expiresAt: expect.any(Date),
  });
  const input = { invitationId, name: "New member", password };
  await expect(anyone.accept({ ...input, password: "short" })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  const results = await Promise.allSettled([anyone.accept(input), anyone.accept(input)]);
  expect(results).toContainEqual({ status: "fulfilled", value: { email } });
  expect(results).toContainEqual({
    status: "rejected",
    reason: expect.objectContaining({ code: "NOT_FOUND" }),
  });
  await expect(anyone.preview({ invitationId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  const cookie = await system.signIn({ email, password });
  await system.client({ cookie }).apiKeys.list();
});

test("only the invited account can rejoin with its existing credentials", async () => {
  const email = "returning@example.com";
  const person = await system.addMember({ name: "Returning member", email });
  await system.ownerAuth().organization.removeMember({ memberIdOrEmail: email, organizationId });
  const { id: invitationId } = await invite(email, "member");
  await expect(
    system.client().invitations.accept({ invitationId, name: "Replacement", password }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(system.owner().invitations.accept({ invitationId })).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  expect(await person.client.invitations.accept({ invitationId })).toEqual({ email });
  await person.client.runners.list();
  await expect(person.client.invitations.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
});

test("public sign-up and native invitation redemption stay closed", async () => {
  const email = "closed@example.com";
  const { id: invitationId } = await invite(email, "member");
  expect((await authPost("sign-up/email", { name: "Closed", email, password })).status).toBe(400);
  for (const action of ["accept", "reject"]) {
    expect((await authPost(`organization/${action}-invitation`, { invitationId })).status).toBe(
      404,
    );
  }
  await system.client().invitations.accept({ invitationId, name: "Invited", password });
});

test("only owners see owner grants, and departure ends invitation authority while preserving key attribution", async () => {
  const email = "inviter@example.com";
  const { id: invitationId } = await invite(email, ["owner", "admin"]);
  await system.client().invitations.accept({ invitationId, name: "Inviter", password });
  const cookie = await system.signIn({ email, password });
  const ownerGrant = await invite("another-owner@example.com", ["admin", "owner"], cookie);
  const memberGrant = await invite("another-member@example.com", "member", cookie);
  const ownerOnly = await invite("original-owner-grant@example.com", "owner");
  const { id: keyId } = await system
    .client({ cookie })
    .apiKeys.create({ name: "Shared", permissions: { runner: ["read"] } });
  const client = system.client().invitations;
  const listed = await system.owner().invitations.list();
  expect(listed).toContainEqual(
    expect.objectContaining({
      id: ownerGrant.id,
      inviter: { id: expect.any(String), name: "Inviter" },
    }),
  );
  await system.ownerAuth().organization.updateMemberRole({
    memberId: await memberId(email),
    role: "admin",
    organizationId,
  });
  const protectedOwner = await authPost(
    "organization/remove-member",
    { memberIdOrEmail: OWNER.email, organizationId },
    cookie,
  );
  expect(protectedOwner.status).toBe(400);
  const asAdmin = await system.client({ cookie }).invitations.list();
  expect(asAdmin.map((row) => row.id)).toContain(memberGrant.id);
  expect(asAdmin.map((row) => row.id)).not.toContain(ownerOnly.id);

  async function expectDead(id: string) {
    const dead = { code: "NOT_FOUND", message: "This invitation is no longer available" };
    await expect(client.preview({ invitationId: id })).rejects.toMatchObject(dead);
    await expect(
      client.accept({ invitationId: id, name: "Unclaimed", password }),
    ).rejects.toMatchObject(dead);
    expect((await system.owner().invitations.list()).map((row) => row.id)).not.toContain(id);
  }
  await expectDead(ownerGrant.id);
  await system.ownerAuth().organization.removeMember({ memberIdOrEmail: email, organizationId });
  await expectDead(memberGrant.id);
  const keys = await system.owner().apiKeys.list();
  expect(keys.find((key) => key.id === keyId)?.creator).toMatchObject({
    name: "Inviter",
    isMember: false,
  });
  const replacement = await invite(memberGrant.email, "member");
  expect(replacement.id).not.toBe(memberGrant.id);
  await client.preview({ invitationId: replacement.id });
});

test("two owners leaving together leave one owner who can still register Runners", async () => {
  const email = "second-owner@example.com";
  const { id: invitationId } = await invite(email, ["admin", "owner"]);
  await system.client().invitations.accept({ invitationId, name: "Second owner", password });
  await system.ownerAuth().organization.updateMemberRole({
    memberId: await memberId(OWNER.email),
    role: ["owner", "admin"],
    organizationId,
  });
  const registration = await system.createRegistrationKey();
  const cookies = [system.ownerCookie(), await system.signIn({ email, password })];
  await using database = openDatabase(inject("databaseUrl"));
  const writes = await database.transaction().execute(async (tx) => {
    // Let both HTTP requests finish Better Auth's owner count before either can delete a member.
    await sql`lock table elflodge.member in share mode`.execute(tx);
    const pending = Promise.all(
      cookies.map((cookie) => authPost("organization/leave", { organizationId }, cookie)),
    );
    await expect
      .poll(async () => {
        const waiting = await sql<{ count: number }>`select count(*) from pg_locks
        where relation = 'elflodge.member'::regclass and mode = 'RowExclusiveLock' and not granted`.execute(
          tx,
        );
        return waiting.rows[0]?.count;
      })
      .toBe(2);
    return { pending };
  });
  const departures = await writes.pending;
  expect(departures.map((response) => response.status).toSorted((a, b) => a - b)).toEqual([
    200, 400,
  ]);
  const refused = departures.find((response) => response.status === 400);
  expect(refused?.headers.get("content-type")).toContain("application/json");
  expect(await refused?.json()).toMatchObject({
    code: "YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER",
  });
  await system.runnerClient({ "x-api-key": registration }).register({ name: "After handoff" });
  const cookie = cookies[departures.findIndex((response) => response.status === 400)];
  if (!cookie) throw new Error("Missing remaining owner's session");
  const { members } = await system
    .authClient(cookie)
    .organization.listMembers({ query: { organizationId } });
  const remaining = members.find((member) => member.role.split(",").includes("owner"));
  if (!remaining) throw new Error("The Organization has no owner");
  for (const [action, body] of [
    ["remove-member", { memberIdOrEmail: remaining.id }],
    ["update-member-role", { memberId: remaining.id, role: "admin" }],
  ] as const) {
    const response = await authPost(`organization/${action}`, { organizationId, ...body }, cookie);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code:
        action === "remove-member"
          ? "YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER"
          : "YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER",
    });
  }
});
