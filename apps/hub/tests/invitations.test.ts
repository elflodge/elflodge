import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from "vite-plus/test";

import { openDatabase } from "../src/db/database.ts";
import { OWNER, startSystem } from "./harness.ts";

const system = startSystem();
let organizationId: string;

async function start() {
  await system.start();
  const [organization] = await system.ownerAuth().organization.list();
  if (!organization) throw new Error("The hub has no Organization");
  organizationId = organization.id;
}

beforeAll(start);
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

/** Invites and admits an account with the role, and returns that account's signed-in cookie. */
async function joinAsInviter(email: string, role: "admin" | ("owner" | "admin")[]) {
  const { id: invitationId } = await invite(email, role);
  await system.client().invitations.accept({ invitationId, name: "Inviter", password });
  return system.signIn({ email, password });
}

async function expectUnavailable(invitationId: string) {
  const dead = { code: "NOT_FOUND", message: "This invitation is no longer available" };
  const client = system.client().invitations;
  await expect(client.preview({ invitationId })).rejects.toMatchObject(dead);
  await expect(client.accept({ invitationId, name: "Unclaimed", password })).rejects.toMatchObject(
    dead,
  );
  expect((await system.owner().invitations.list()).map((row) => row.id)).not.toContain(
    invitationId,
  );
}

test("an admin's re-invite preserves a live owner invitation and its grant", async () => {
  const cookie = await joinAsInviter("inviting-admin@example.com", "admin");
  const email = "invited-owner@example.com";
  const { id: invitationId } = await invite(email, "owner");
  const response = await authPost(
    "organization/invite-member",
    { email: email.toUpperCase(), role: "member", organizationId },
    cookie,
  );
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({
    code: "YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE",
  });

  const invitations = system.client().invitations;
  expect(await invitations.preview({ invitationId })).toMatchObject({ email, role: "owner" });
  await invitations.accept({ invitationId, name: "Invited owner", password });
  const { members } = await system
    .ownerAuth()
    .organization.listMembers({ query: { organizationId } });
  expect(members.find((member) => member.user.email === email)?.role).toBe("owner");
});

test("only an owner can cancel an invitation granting owner by ID", async () => {
  const cookie = await joinAsInviter("canceling-admin@example.com", "admin");
  const { id: invitationId } = await invite("cancel-owner@example.com", ["admin", "owner"]);
  const response = await authPost("organization/cancel-invitation", { invitationId }, cookie);
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({
    code: "YOU_ARE_NOT_ALLOWED_TO_CANCEL_THIS_INVITATION",
  });
  await system.client().invitations.preview({ invitationId });
  await system.ownerAuth().organization.cancelInvitation({ invitationId });
  await expectUnavailable(invitationId);
});

test("an owner can replace an admin's member invitation in one call", async () => {
  const cookie = await joinAsInviter("replaced-inviter@example.com", "admin");
  const email = "replacement@example.com";
  const original = await invite(email, "member", cookie);
  const replacement = await invite(email, "admin");
  await expectUnavailable(original.id);
  const invitations = system.client().invitations;
  expect(await invitations.preview({ invitationId: replacement.id })).toMatchObject({
    email,
    role: "admin",
  });
  await invitations.accept({ invitationId: replacement.id, name: "Replacement", password });
});

test("renewal works while the inviter can grant the role and replacement works after demotion", async () => {
  const inviterEmail = "demoted-owner@example.com";
  const inviter = await joinAsInviter(inviterEmail, ["owner"]);
  const admin = await joinAsInviter("replacement-admin@example.com", "admin");
  const email = "reinvited-member@example.com";
  const original = await invite(email, "owner", inviter);
  const resend = () =>
    authPost(
      "organization/invite-member",
      { email, role: "owner", organizationId, resend: true },
      system.ownerCookie(),
    );
  const renewed = await resend();
  expect(renewed.status).toBe(200);
  expect(await renewed.json()).toMatchObject({ id: original.id });
  const inviterMemberId = await memberId(inviterEmail);
  await system.ownerAuth().organization.updateMemberRole({
    memberId: inviterMemberId,
    role: "admin",
    organizationId,
  });

  const refused = await resend();
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({
    message: "This invitation can no longer be renewed. Create a new invitation.",
  });

  const replacement = await invite(email, "member", admin);
  await system.ownerAuth().organization.updateMemberRole({
    memberId: inviterMemberId,
    role: "owner",
    organizationId,
  });
  await expectUnavailable(original.id);
  expect(await system.client().invitations.preview({ invitationId: replacement.id })).toMatchObject(
    {
      email,
      role: "member",
    },
  );
});

test("demotion to admin voids owner grants, hides owner invitations and prevents removing an owner", async () => {
  const email = "inviter@example.com";
  const cookie = await joinAsInviter(email, ["owner", "admin"]);
  const ownerGrant = await invite("another-owner@example.com", ["admin", "owner"], cookie);
  const memberGrant = await invite("another-member@example.com", "member", cookie);
  const ownerOnly = await invite("original-owner-grant@example.com", "owner");
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

  await expectUnavailable(ownerGrant.id);
});

test("removal voids an inviter's outstanding grants and preserves key attribution", async () => {
  const email = "departing-admin@example.com";
  const cookie = await joinAsInviter(email, "admin");
  const memberGrant = await invite("another-member@example.com", "member", cookie);
  const { id: keyId } = await system
    .client({ cookie })
    .apiKeys.create({ name: "Shared", permissions: { runner: ["read"] } });
  await system.ownerAuth().organization.removeMember({ memberIdOrEmail: email, organizationId });
  await expectUnavailable(memberGrant.id);
  const keys = await system.owner().apiKeys.list();
  expect(keys.find((key) => key.id === keyId)?.creator).toMatchObject({
    name: "Inviter",
    isMember: false,
  });
  const replacement = await invite(memberGrant.email, "member");
  expect(replacement.id).not.toBe(memberGrant.id);
  await system.client().invitations.preview({ invitationId: replacement.id });
});

describe("owner races", () => {
  // Each race needs exactly two owners and may remove the hub's first owner, so it starts on a
  // fresh database.
  beforeEach(async () => {
    await system.stop();
    await start();
  });

  test.each(["leave", "self-demotion"] as const)(
    "an owner's %s racing another owner's departure leaves one owner who can register Runners",
    async (firstAction) => {
      const email = "second-owner@example.com";
      const { id: invitationId } = await invite(email, ["admin", "owner"]);
      await system.client().invitations.accept({ invitationId, name: "Second owner", password });
      const firstOwner = await memberId(OWNER.email);
      await system.ownerAuth().organization.updateMemberRole({
        memberId: firstOwner,
        role: ["owner", "admin"],
        organizationId,
      });
      const registration = await system.createRegistrationKey();
      const firstCookie = system.ownerCookie();
      const secondCookie = await system.signIn({ email, password });
      await using database = openDatabase(inject("databaseUrl"));
      const writes = await database.transaction().execute(async (tx) => {
        // Let both requests finish Better Auth's owner count before either can change a membership.
        await sql`lock table elflodge.member in share mode`.execute(tx);
        const pending = Promise.all([
          firstAction === "leave"
            ? authPost("organization/leave", { organizationId }, firstCookie)
            : authPost(
                "organization/update-member-role",
                { memberId: firstOwner, role: "admin", organizationId },
                firstCookie,
              ),
          authPost("organization/leave", { organizationId }, secondCookie),
        ]);
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
      const [first, second] = await writes.pending;
      expect(first.ok).not.toBe(second.ok);
      await system.runnerClient({ "x-api-key": registration }).register({ name: "After handoff" });
      const cookie = first.ok ? secondCookie : firstCookie;
      const { members } = await system
        .authClient(cookie)
        .organization.listMembers({ query: { organizationId } });
      const owners = members.filter((member) => member.role.split(",").includes("owner"));
      expect(owners).toHaveLength(1);
      const [remaining] = owners;
      if (!remaining) throw new Error("The Organization has no owner");
      for (const [action, body] of [
        ["remove-member", { memberIdOrEmail: remaining.id }],
        ["update-member-role", { memberId: remaining.id, role: "admin" }],
      ] as const) {
        const response = await authPost(
          `organization/${action}`,
          { organizationId, ...body },
          cookie,
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          code:
            action === "remove-member"
              ? "YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER"
              : "YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER",
        });
      }
    },
  );
});
