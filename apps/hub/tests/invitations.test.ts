import { INVITATION_HEADER } from "contract";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

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

function authPost(path: string, body: object, cookie?: string, invitationId?: string) {
  return system.hub.fetch(`/api/auth/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: system.origin,
      ...(cookie && { cookie }),
      ...(invitationId && { [INVITATION_HEADER]: invitationId }),
    },
    body: JSON.stringify(body),
  });
}

test("the only owner can register a Runner with a combined role and cannot give up ownership", async () => {
  const id = await memberId(OWNER.email);
  const organization = system.ownerAuth().organization;
  await organization.updateMemberRole({ memberId: id, role: ["admin", "owner"], organizationId });
  const registration = await system.createRegistrationKey();
  await system.runnerClient({ "x-api-key": registration }).register({ name: "First Runner" });

  for (const [action, body, code] of [
    [
      "remove-member",
      { memberIdOrEmail: id },
      "YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER",
    ],
    [
      "update-member-role",
      { memberId: id, role: "admin" },
      "YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER",
    ],
  ] as const) {
    const response = await authPost(
      `organization/${action}`,
      { organizationId, ...body },
      system.ownerCookie(),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code });
  }
  await organization.updateMemberRole({ memberId: id, role: "owner", organizationId });
});

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
  const cookie = await register(email, invitationId);
  const accept = () => authPost("organization/accept-invitation", { invitationId }, cookie);
  const results = await Promise.all([accept(), accept()]);
  expect(results.map((result) => result.status).toSorted((left, right) => left - right)).toEqual([
    200, 400,
  ]);
  await expect(anyone.preview({ invitationId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  const revoke = await authPost(
    "organization/cancel-invitation",
    { invitationId },
    system.ownerCookie(),
  );
  expect(await revoke.json()).toMatchObject({ code: "INVITATION_NOT_FOUND" });
  await system.client({ cookie }).apiKeys.list();
});

test("only the invited account can rejoin with its existing credentials", async () => {
  const email = "returning@example.com";
  const person = await system.addMember({ name: "Returning member", email });
  await system.ownerAuth().organization.removeMember({ memberIdOrEmail: email, organizationId });
  const { id: invitationId } = await invite(email, "member");
  const replacement = await authPost(
    "sign-up/email",
    { email, name: "Replacement", password },
    undefined,
    invitationId,
  );
  expect(await replacement.json()).toMatchObject({ code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" });
  expect(
    (await authPost("organization/accept-invitation", { invitationId }, system.ownerCookie()))
      .status,
  ).toBe(403);
  await system.authClient(person.cookie).organization.acceptInvitation({ invitationId });
  await person.client.runners.list();
  await expect(person.client.invitations.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
});

test("registration needs a live invitation for the same address, and registration alone grants no membership", async () => {
  const email = "closed@example.com";
  const { id } = await invite(email, "member");
  const body = { name: "Invited", email, password };
  expect((await authPost("sign-up/email", body)).status).toBe(403);
  expect(
    (await authPost("sign-up/email", { ...body, email: "other@example.com" }, undefined, id))
      .status,
  ).toBe(403);
  const cookie = await register(email, id);
  await expect(system.client({ cookie }).runners.list()).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await system.authClient(cookie).organization.rejectInvitation({ invitationId: id });
  await expectUnavailable(id);
});

async function register(email: string, id: string) {
  const response = await authPost(
    "sign-up/email",
    { name: "Inviter", email, password },
    undefined,
    id,
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Sign-up did not sign the invitee in");
  return cookie;
}

async function join(email: string, id: string) {
  const cookie = await register(email, id);
  await system.authClient(cookie).organization.acceptInvitation({ invitationId: id });
  return cookie;
}

/** Invites and admits an account with the role, and returns that account's signed-in cookie. */
async function joinAsInviter(email: string, role: "admin" | ("owner" | "admin")[]) {
  const { id: invitationId } = await invite(email, role);
  return join(email, invitationId);
}

async function expectUnavailable(invitationId: string) {
  const dead = { code: "NOT_FOUND", message: "This invitation is no longer available" };
  const client = system.client().invitations;
  await expect(client.preview({ invitationId })).rejects.toMatchObject(dead);
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
  await join(email, invitationId);
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
  await join(email, replacement.id);
});

test("a resend renews while the inviter can grant the role, is refused after demotion without spending the session's renewal, and a replacement works", async () => {
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

  await system.makeSessionDueForRenewal(system.ownerCookie());
  const refused = await resend();
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({
    message: "This invitation can no longer be renewed. Create a new invitation.",
  });
  // The refusal leaves the renewal to get-session, which sends the cookie.
  const session = await system.hub.fetch("/api/auth/get-session", {
    headers: { cookie: system.ownerCookie() },
  });
  expect(session.headers.get("set-cookie")).toContain("session_token=");

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
  const invitee = await register(ownerGrant.email, ownerGrant.id);
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
  const refused = await authPost(
    "organization/accept-invitation",
    { invitationId: ownerGrant.id },
    invitee,
  );
  expect(await refused.json()).toMatchObject({ code: "INVITATION_NOT_FOUND" });
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
