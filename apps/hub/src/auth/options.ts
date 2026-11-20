import { apiKey } from "@better-auth/api-key";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { ORGANIZATION_ERROR_CODES } from "better-auth/client/plugins";
import { generateRandomString } from "better-auth/crypto";
import { customSession, organization } from "better-auth/plugins";
import { GRANTABLE_KEY_PERMISSIONS, MAX_API_KEY_NAME_LENGTH } from "contract";
import type { Kysely } from "kysely";
import { jsonBuildObject } from "kysely/helpers/postgres";

import { DB_SCHEMA } from "../db/database.ts";
import { type Database, OrganizationId, UserId } from "../db/types.ts";
import { ac, roles } from "./access.ts";
import { findProtectedInvitation, mayGrantRole } from "./invitation-grants.ts";

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
 * A member gets the Organization and role. Other accounts get only the `notMember` or
 * `hubNotSetUp` status.
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
export function authOptions(settings: AuthSettings) {
  const db = settings.db.withSchema(DB_SCHEMA);
  return {
    secret: settings.secret,
    baseURL: settings.baseURL,
    database: {
      db: settings.db,
      type: "postgres",
      schemaName: DB_SCHEMA,
      // Setup and invitation redemption each supply a Kysely transaction that cannot open another.
      transaction: !settings.db.isTransaction,
    },
    // Members sign in with a password (ADR 0015); only setup and invitation redemption sign anyone up.
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
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
    // removed Runner's connection. Its invitation claim must also verify the inviter's current
    // authority. Better Auth's server-side calls still work.
    disabledPaths: [
      "/organization/accept-invitation",
      "/organization/reject-invitation",
      "/api-key/create",
      "/api-key/get",
      "/api-key/list",
      "/api-key/update",
      "/api-key/delete",
    ],
    hooks: {
      // Who may replace an invitation follows who may see it and grant its role. Inviting an address
      // again replaces its pending invitation, so a request hook decides before anything is
      // replaced. Remove it when the library enforces the same rule itself (ADR 0015).
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/organization/invite-member" || ctx.body?.resend === true) return;
        const email = ctx.body?.email;
        if (typeof email !== "string") return;
        const session = await getSessionFromCtx(ctx);
        if (!session)
          throw APIError.from("UNAUTHORIZED", { code: "UNAUTHORIZED", message: "Unauthorized" });
        const organizationId = ctx.body.organizationId || session.session.activeOrganizationId;
        if (typeof organizationId !== "string") return;
        const protectedInvitation = await findProtectedInvitation(
          db,
          OrganizationId(organizationId),
          UserId(session.user.id),
          email,
        );
        if (protectedInvitation)
          throw APIError.from(
            "FORBIDDEN",
            ORGANIZATION_ERROR_CODES.YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE,
          );
      }),
    },
    logger: {
      // Better Auth's lines go to the console like the hub's own, without terminal colours, so Workers
      // Logs keeps them with the request they belong to.
      log: (level, message, ...args) => console[level](`[Better Auth] ${message}`, ...args),
    },
    plugins: [
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
          // Only a member who could grant an invitation's role may cancel it. Remove this when the
          // library enforces the same rule itself (ADR 0015).
          async beforeCancelInvitation({ invitation, cancelledBy }) {
            const member = await db
              .selectFrom("member")
              .where("organizationId", "=", OrganizationId(invitation.organizationId))
              .where("userId", "=", UserId(cancelledBy.id))
              .select((eb) => mayGrantRole(eb.ref("role"), eb.val(invitation.role)).as("mayGrant"))
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
          // API rate limits are a separate concern; per-key limits would add a write to every request.
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
  return authOptions({
    db,
    secret: generateRandomString(64),
    baseURL: "http://localhost",
    ipAddressHeaders: [],
    trustedProxies: [],
    rateLimit: true,
  });
}

/** Setup and invitation redemption enable registration only inside their claim transaction. */
export function signUpAuth(options: ReturnType<typeof authOptions>) {
  return betterAuth({
    ...options,
    emailAndPassword: { ...options.emailAndPassword, disableSignUp: false, autoSignIn: false },
  });
}
