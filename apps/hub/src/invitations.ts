import { ORPCError } from "@orpc/server";
import { InvitationUnavailable } from "contract";
import { Effect, Predicate } from "effect";
import type { Kysely } from "kysely";
import { jsonBuildObject } from "kysely/helpers/postgres";

import { roles } from "./auth/access.ts";
import { Auth, requireRolePermission } from "./auth/auth.ts";
import { Db, storedRoles } from "./db/database.ts";
import { type Database, type InvitationId, type OrganizationId, UserId } from "./db/types.ts";

const invitationRoles = Object.entries(roles)
  .filter(([, role]) => role.authorize({ invitation: ["create"] }).success)
  .map(([name]) => name);

/** Only invitations the original inviter could issue now are visible or redeemable. */
function liveInvitations(db: Kysely<Database>) {
  return db
    .selectFrom("invitation")
    .innerJoin("member", (join) =>
      join
        .onRef("member.organizationId", "=", "invitation.organizationId")
        .onRef("member.userId", "=", "invitation.inviterId"),
    )
    .where("invitation.status", "=", "pending")
    .where("invitation.expiresAt", ">", (eb) => eb.fn<Date>("clock_timestamp"))
    .where((eb) => {
      const inviter = storedRoles(eb.ref("member.role"));
      const grant = storedRoles(eb.ref("invitation.role"));
      return eb.and([
        eb(inviter, "&&", eb.val(invitationRoles)),
        eb(grant, "<@", eb.val(Object.keys(roles))),
        eb.or([
          eb(eb.val("owner"), "=", eb.fn.any(inviter)),
          eb.not(eb(eb.val("owner"), "=", eb.fn.any(grant))),
        ]),
      ]);
    });
}

export function previewInvitation(id: InvitationId) {
  return Db.use((database) =>
    database.query((db) =>
      liveInvitations(db)
        .innerJoin("organization", "organization.id", "invitation.organizationId")
        .where("invitation.id", "=", id)
        .select([
          "invitation.email",
          "invitation.role",
          "invitation.expiresAt",
          "organization.name as organizationName",
        ])
        .$narrowType<{ role: string }>()
        .executeTakeFirst(),
    ),
  ).pipe(Effect.filterOrFail(Predicate.isNotUndefined, () => new InvitationUnavailable()));
}

export function listInvitations(organizationId: OrganizationId, role: string) {
  return Effect.gen(function* () {
    yield* requireRolePermission(role, { invitation: ["create"] });
    return yield* Db.use((database) =>
      database.query((db) =>
        liveInvitations(db)
          .innerJoin("user", "user.id", "invitation.inviterId")
          .where("invitation.organizationId", "=", organizationId)
          .where((eb) =>
            eb.or([
              eb(eb.val("owner"), "=", eb.fn.any(storedRoles(eb.val(role)))),
              eb.not(eb(eb.val("owner"), "=", eb.fn.any(storedRoles(eb.ref("invitation.role"))))),
            ]),
          )
          .select([
            "invitation.id",
            "invitation.email",
            "invitation.role",
            "invitation.createdAt",
            "invitation.expiresAt",
          ])
          .select((eb) =>
            jsonBuildObject({ id: eb.ref("user.id"), name: eb.ref("user.name") }).as("inviter"),
          )
          .$narrowType<{ role: string }>()
          .orderBy("invitation.createdAt", "desc")
          .orderBy("invitation.id")
          .execute(),
      ),
    );
  });
}

export function acceptInvitation(
  id: InvitationId,
  headers: Headers,
  name?: string,
  password?: string,
) {
  return Auth.use((service) =>
    service.signUpTransaction(async (db, auth) => {
      const eligible = liveInvitations(db)
        .where("invitation.id", "=", id)
        .select("invitation.id")
        .forShare("member");
      const grant = await db
        .deleteFrom("invitation")
        .where("id", "in", eligible)
        .where("status", "=", "pending")
        .where("expiresAt", ">", (eb) => eb.fn<Date>("clock_timestamp"))
        .returning((eb) => ["email", "organizationId", storedRoles(eb.ref("role")).as("roles")])
        // liveInvitations requires every granted role to belong to the configured static roles.
        .$narrowType<{ roles: (keyof typeof roles)[] }>()
        .executeTakeFirst();
      if (!grant) throw new InvitationUnavailable();

      // addMember counts before inserting. Admissions take turns so the final place goes to one.
      await db
        .selectFrom("organization")
        .select("id")
        .where("id", "=", grant.organizationId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      const account = await db
        .selectFrom("user")
        .select("id")
        .where("email", "=", grant.email)
        .executeTakeFirst();
      let userId;
      if (account) {
        const session = await auth.api.getSession({ headers, method: "GET" });
        if (!session)
          throw new ORPCError("UNAUTHORIZED", { message: "Sign in with the invited account" });
        if (session.user.id !== account.id)
          throw new ORPCError("FORBIDDEN", { message: "Sign in with the invited account" });
        userId = account.id;
      } else {
        if (!name || password === undefined)
          throw new ORPCError("BAD_REQUEST", {
            message: "A new account needs a name and password",
          });
        const { user } = await auth.api.signUpEmail({
          body: { email: grant.email, name, password },
        });
        // signUpEmail can return a synthetic ID if another registration took the address.
        const created = await db
          .selectFrom("user")
          .select("id")
          .where("email", "=", grant.email)
          .where("id", "=", UserId(user.id))
          .executeTakeFirst();
        if (!created)
          throw new ORPCError("UNAUTHORIZED", { message: "Sign in with the invited account" });
        userId = created.id;
      }
      await auth.api.addMember({
        body: { userId, organizationId: grant.organizationId, role: grant.roles },
      });
      return { email: grant.email };
    }),
  );
}

export const sweepInvitations = Db.use((database) =>
  database.query((db) =>
    db
      .deleteFrom("invitation")
      .where((eb) =>
        eb.or([eb("status", "!=", "pending"), eb("expiresAt", "<=", eb.fn<Date>("now"))]),
      )
      .execute(),
  ),
);
