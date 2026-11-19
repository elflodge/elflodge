import { apiKey } from "@better-auth/api-key";
import type { BetterAuthOptions } from "better-auth";
import { generateRandomString } from "better-auth/crypto";
import { customSession, organization } from "better-auth/plugins";
import { KEY_PERMISSIONS } from "contract";
import type { Kysely } from "kysely";

import { DB_SCHEMA } from "../db/database.ts";
import { type Database, UserId } from "../db/types.ts";
import { ac, roles } from "./access.ts";

// Loading this module has no side effects (no environment reads or connections), so Better Auth's
// CLI can load it to draft the schema (ADR 0020).

/**
 * The permissions a member may grant an API key, as a role whose `authorize` checks a request. A
 * Runner's own key, with `RUNNER_KEY_PERMISSIONS`, is created only by the hub when the Runner
 * registers.
 */
export const GRANTABLE_KEY_PERMISSIONS = ac.newRole({
  runner: ["register"],
  job: KEY_PERMISSIONS.job,
});

/** The permissions of a Runner's own key, which the hub creates when the Runner registers. */
export const RUNNER_KEY_PERMISSIONS = ac.newRole({ runner: ["actAs"] });

/**
 * What starts the identifier of a setup link's token in Better Auth's `verification` table, which
 * Better Auth stores by its digest.
 */
export const SETUP_TOKEN_PREFIX = "hub-setup:";

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

/** Read the Organization and this user's role from one snapshot, even after membership removal. */
async function findMembership(db: Kysely<Database>, userId: UserId) {
  const row = await db
    .withSchema(DB_SCHEMA)
    .selectFrom("organization")
    .leftJoin("member", (join) =>
      join.onRef("member.organizationId", "=", "organization.id").on("member.userId", "=", userId),
    )
    .select(["organization.id", "organization.name", "member.role"])
    .limit(1)
    .executeTakeFirst();
  // Setup in 0.10.0 and earlier could leave an owner account behind before creating the Organization.
  if (!row) return { status: "hubNotSetUp" } as const;
  if (row.role === null) return { status: "notMember" } as const;
  // Better Auth infers the JSON response from this value. Database ID brands are local to the hub.
  const id: string = row.id;
  return {
    status: "member",
    organization: { id, name: row.name },
    role: row.role,
  } as const;
}

/** Better Auth's options for the hub. */
export function authOptions(settings: AuthSettings) {
  return {
    secret: settings.secret,
    baseURL: settings.baseURL,
    database: {
      db: settings.db,
      type: "postgres",
      schemaName: DB_SCHEMA,
      // Setup creates the owner and Organization in one Kysely transaction, which cannot open another.
      transaction: !settings.db.isTransaction,
    },
    // Members sign in with a password (ADR 0015); only the hub's setup signs anyone up.
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
    // removed Runner's connection; Better Auth's would skip both. Its server-side calls still work.
    disabledPaths: [
      "/api-key/create",
      "/api-key/get",
      "/api-key/list",
      "/api-key/update",
      "/api-key/delete",
    ],
    logger: {
      // Better Auth's lines go to the console like the hub's own, without terminal colours, so Workers
      // Logs keeps them with the request they belong to.
      log: (level, message, ...args) => console[level](`[Better Auth] ${message}`, ...args),
    },
    plugins: [
      customSession(async ({ user, session }) => {
        const membership = await findMembership(settings.db, UserId(user.id));
        return { user, session, membership };
      }),
      // One Organization per deployment (ADR 0007): only the hub's setup creates it, and nothing
      // deletes it, since a hub without it answers no member or key.
      organization({
        ac,
        roles,
        allowUserToCreateOrganization: false,
        disableOrganizationDeletion: true,
      }),
      apiKey([
        {
          configId: API_KEY_CONFIG,
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
