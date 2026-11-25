import { apiKey } from "@better-auth/api-key";
import type { BetterAuthOptions } from "better-auth";
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
  setShouldSkipSessionRefresh,
} from "better-auth/api";
import { ORGANIZATION_ERROR_CODES } from "better-auth/client/plugins";
import { generateRandomString } from "better-auth/crypto";
import { customSession, organization } from "better-auth/plugins";
import {
  GRANTABLE_KEY_PERMISSIONS,
  INVITATION_HEADER,
  nameSchema,
  MAX_API_KEY_NAME_LENGTH,
  PASSWORD_LENGTH,
} from "contract";
import type { Kysely } from "kysely";
import { jsonBuildObject } from "kysely/helpers/postgres";
import * as z from "zod/mini";

import { DB_SCHEMA } from "../db/database.ts";
import { type Database, InvitationId, OrganizationId, UserId } from "../db/types.ts";
import { ac, roles } from "./access.ts";
import {
  findInvitationInviterCannotGrantByEmail,
  findLiveInvitationCallerCannotGrantByEmail,
  liveInvitations,
  mayGrantRole,
} from "./invitation-grants.ts";

// Loading this module has no side effects (no environment reads or connections), so Better Auth's
// CLI can load it to draft the schema (ADR 0020).

/**
 * The permissions a member may grant an API key, as a role whose `authorize` checks a request. A
 * Runner's own key, with `RUNNER_KEY_ROLE`, is created only by the hub when the Runner
 * registers.
 */
export const GRANTABLE_KEY_ROLE = ac.newRole(GRANTABLE_KEY_PERMISSIONS);

/** The permissions of a Runner's own key, which the hub creates when the Runner registers. */
export const RUNNER_KEY_ROLE = ac.newRole({ runner: ["actAs"] });

/** The `value` of a setup link's `verification` row, by which a new link revokes older ones. */
export const SETUP_LINK_VALUE = "hub-setup";

/**
 * What starts the identifier of a setup link's token in Better Auth's `verification` table, which
 * Better Auth stores by its digest.
 */
export const SETUP_TOKEN_PREFIX = `${SETUP_LINK_VALUE}:`;

/** The API key configurations: keys for services, and each Runner's own key. */
export const API_KEY_CONFIG = "default";
export const RUNNER_KEY_CONFIG = "runner";

const invitationEmail = z.email();

export interface AuthSettings {
  /**
   * The hub's database. Better Auth names `schemaName` itself, so a schema plugin on it must name
   * the same schema, as the hub's does.
   */
  db: Kysely<Database>;
  secret: string;
  /** The hub's public URL, which Better Auth uses for its routes and cookies. */
  baseURL: string;
  /**
   * The request headers that carry the client's IP address, for rate limiting; when unset, Better
   * Auth's default, `x-forwarded-for`.
   */
  ipAddressHeaders?: string[] | undefined;
  /**
   * The proxies in front of the hub, as IPs or CIDRs. Better Auth reads a forwarded chain from the
   * right, skipping these, so a client cannot name its own address; with none, only a chain of one
   * address counts.
   */
  trustedProxies: string[];
  /** Whether Better Auth's rate limits apply; tests turn them off. */
  rateLimit: boolean;
}

/**
 * Read the Organization and membership together. Better Auth's `getActiveMemberRole` needs an
 * Organization and returns only the role, so using it here would add reads. The single query also
 * distinguishes a hub awaiting setup from a signed-in account without membership. Only members
 * get the Organization and role.
 */
async function findMembership(db: Kysely<Database>, userId: UserId) {
  const row = await db
    .withSchema(DB_SCHEMA)
    .selectFrom("organization")
    .leftJoin("member", (join) =>
      join.onRef("member.organizationId", "=", "organization.id").on("member.userId", "=", userId),
    )
    .select((eb) => [
      jsonBuildObject({ id: eb.ref("organization.id"), name: eb.ref("organization.name") }).as(
        "organization",
      ),
      "member.role",
    ])
    .limit(1)
    .executeTakeFirst();
  // Setup in 0.10.0 and earlier could leave an owner account behind before creating the Organization.
  if (!row) return { status: "hubNotSetUp" } as const;
  if (row.role === null) return { status: "notMember" } as const;
  return {
    status: "member",
    organization: row.organization,
    role: row.role,
  } as const;
}

/** Better Auth's options for the hub. */
export function authOptions(
  settings: AuthSettings,
  registration: "invitation" | "setup" = "invitation",
) {
  const db = settings.db.withSchema(DB_SCHEMA);
  async function requireInvitation(id: string | null | undefined, email: unknown) {
    const invitation = id
      ? await liveInvitations(db)
          .where("invitation.id", "=", InvitationId(id))
          .select("invitation.email")
          .executeTakeFirst()
      : undefined;
    if (!invitation || typeof email !== "string" || invitation.email !== email.toLowerCase()) {
      throw APIError.from("FORBIDDEN", ORGANIZATION_ERROR_CODES.INVITATION_NOT_FOUND);
    }
  }
  return {
    secret: settings.secret,
    baseURL: settings.baseURL,
    database: {
      db: settings.db,
      type: "postgres",
      schemaName: DB_SCHEMA,
      // Setup supplies a Kysely transaction that cannot open another.
      transaction: !settings.db.isTransaction,
    },
    // Members sign in with a password (ADR 0015); only setup and invitation redemption sign anyone up.
    emailAndPassword: {
      enabled: true,
      minPasswordLength: PASSWORD_LENGTH.min,
      maxPasswordLength: PASSWORD_LENGTH.max,
      // Setup has no browser to receive a session cookie.
      ...(registration === "setup" && { autoSignIn: false }),
      // A reset is often because the password leaked, so whoever signed in with it is signed out.
      revokeSessionsOnPasswordReset: true,
    },
    verification: {
      // A setup link's token is as good as the owner's password until it is used, so the database
      // keeps only its digest, as Better Auth's option for identifiers offers.
      storeIdentifier: { default: "plain", overrides: { [SETUP_TOKEN_PREFIX]: "hashed" } },
    },
    rateLimit: {
      // Set explicitly: Better Auth enables rate limits only when `NODE_ENV` is `production`, which
      // Workers do not set.
      enabled: settings.rateLimit,
      // Counts kept in memory are per process, so they would split across hub replicas and Workers
      // isolates; the database holds one count for every instance.
      storage: "database",
    },
    advanced: {
      database: {
        // Each request builds its own instance, which would otherwise introspect the database on its
        // first auth call; the schema comes from migrations.
        validateSchema: false,
        joins: true,
      },
      // Which header carries the client's address, and which proxies may have written it, depend on
      // the deployment: Cloudflare sets `cf-connecting-ip`, Railway `x-real-ip`.
      ipAddress: {
        ipAddressHeaders: settings.ipAddressHeaders,
        trustedProxies: settings.trustedProxies,
      },
    },
    // The hub's own routes manage API keys, adding which permissions may be granted and closing a
    // removed Runner's connection. Better Auth's server-side calls still work.
    disabledPaths: [
      "/api-key/create",
      "/api-key/get",
      "/api-key/list",
      "/api-key/update",
      "/api-key/delete",
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/sign-up/email" && registration === "invitation") {
          // Check the link before the endpoint looks up the address or hashes a password.
          await requireInvitation(ctx.headers?.get(INVITATION_HEADER), ctx.body?.email);
          const name = nameSchema.safeParse(ctx.body?.name);
          if (!name.success)
            throw APIError.fromStatus("BAD_REQUEST", { message: "Enter a valid name." });
          return { context: { body: { ...ctx.body, name: name.data } } };
        }
        // Only the hub calls this route, to revoke a key or remove a Runner, with the member's
        // request headers, and it cannot forward the renewal cookie Better Auth would set. The
        // dashboard renews through get-session.
        if (ctx.path === "/api-key/delete") {
          await setShouldSkipSessionRefresh(true);
          return undefined;
        }
        // Better Auth may cancel the old invitation before beforeCreateInvitation runs, and a
        // resend keeps the original inviter. Check both paths before Better Auth changes the row.
        if (ctx.path !== "/organization/invite-member") return undefined;
        const resend = ctx.body?.resend === true;
        // Match the invite request's lowercased address and its explicit or active Organization.
        const address = ctx.body?.email;
        if (typeof address !== "string") return undefined;
        const email = address.toLowerCase();
        if (!invitationEmail.safeParse(email).success) return undefined;
        // A refusal below drops the headers this read would set, so it must not renew.
        const session = await getSessionFromCtx(ctx, { disableRefresh: true });
        if (!session) return undefined;
        const requested = ctx.body.organizationId || session.session.activeOrganizationId;
        if (typeof requested !== "string") return undefined;
        const organizationId = OrganizationId(requested);
        const caller = UserId(session.user.id);
        if (resend) {
          if (await findInvitationInviterCannotGrantByEmail(db, organizationId, caller, email)) {
            throw APIError.fromStatus("CONFLICT", {
              message: "This invitation can no longer be renewed. Create a new invitation.",
            });
          }
        } else if (
          await findLiveInvitationCallerCannotGrantByEmail(db, organizationId, caller, email)
        ) {
          throw APIError.from(
            "FORBIDDEN",
            ORGANIZATION_ERROR_CODES.YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE,
          );
        }
        return undefined;
      }),
    },
    // Workers Logs collects these console lines with the request that produced them.
    logger: { disableColors: true },
    plugins: [
      // A separate `/viewer` endpoint could return the same data, but it would have to forward
      // session renewal cookies. The dashboard already calls Better Auth's `get-session`, which
      // handles renewal and gives the hub's member guard the same session result.
      customSession(async ({ user, session }) => {
        const id = UserId(user.id);
        const membership = await findMembership(settings.db, id);
        return { user: { ...user, id }, session, membership };
      }),
      // One Organization per deployment (ADR 0007): only the hub's setup creates it, and nothing
      // deletes it, since a hub without it answers no member or key.
      organization({
        ac,
        roles,
        allowUserToCreateOrganization: false,
        disableOrganizationDeletion: true,
        cancelPendingInvitationsOnReInvite: true,
        organizationHooks: {
          async beforeAcceptInvitation({ invitation }) {
            // The inviter may have lost authority since the link was shared.
            await requireInvitation(invitation.id, invitation.email);
          },
          // Cancelling by ID requires authority to grant the role even after the invitation lapses.
          async beforeCancelInvitation({ invitation, cancelledBy }) {
            const member = await db
              .selectFrom("member")
              .where("organizationId", "=", OrganizationId(invitation.organizationId))
              .where("userId", "=", UserId(cancelledBy.id))
              .select((eb) => mayGrantRole(eb.ref("role"), eb.val(invitation.role)).as("mayGrant"))
              .limit(1)
              .executeTakeFirst();
            if (!member?.mayGrant)
              throw APIError.from(
                "FORBIDDEN",
                ORGANIZATION_ERROR_CODES.YOU_ARE_NOT_ALLOWED_TO_CANCEL_THIS_INVITATION,
              );
          },
        },
      }),
      apiKey([
        {
          configId: API_KEY_CONFIG,
          maximumNameLength: MAX_API_KEY_NAME_LENGTH,
          references: "organization",
          // API rate limits are a separate concern. Better Auth still records each key's use with
          // per-key rate limits disabled.
          rateLimit: { enabled: false },
          // Better Auth keeps an Organization's key without the member who created it, so the hub
          // records them in the key's metadata. Only the hub writes it: Better Auth's routes that
          // create and update keys are disabled.
          enableMetadata: true,
        },
        {
          configId: RUNNER_KEY_CONFIG,
          references: "organization",
          rateLimit: { enabled: false },
        },
      ]),
    ],
  } satisfies BetterAuthOptions;
}

/**
 * Options for Better Auth instances that serve no requests: setup, recovery and the CLI's schema
 * draft. Nothing they create is signed or served, so a fresh secret (64 characters, as Better Auth's
 * `auth secret` makes) and a placeholder URL do. Rate limits stay on so the CLI's draft includes the
 * table they are kept in; calls made without a request are never limited.
 */
export function offlineAuthOptions(db: Kysely<Database>) {
  return authOptions(
    {
      db,
      secret: generateRandomString(64),
      baseURL: "http://localhost",
      ipAddressHeaders: [],
      trustedProxies: [],
      rateLimit: true,
    },
    "setup",
  );
}
