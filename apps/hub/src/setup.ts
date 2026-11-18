import { betterAuth, type BetterAuthOptions } from "better-auth";
import { generateRandomString } from "better-auth/crypto";
import type { Kysely } from "kysely";

import { findOrganization } from "./auth/auth.ts";
import { offlineAuthOptions, SETUP_TOKEN_PREFIX } from "./auth/options.ts";
import { dashboardUrl } from "./dashboard.ts";
import { DB_SCHEMA, openDatabase } from "./db/database.ts";
import type { Database } from "./db/types.ts";

// A new hub gets its Organization and owner in one of two ways (ADR 0015). Without settings for the
// owner, it prints a setup link, as Jupyter prints its token and Jenkins its initial password, and
// whoever opens it creates the owner in the dashboard; only someone who can read the hub's output
// has it. With `ADMIN_EMAIL` and `ADMIN_PASSWORD`, as Grafana, Authentik and Keycloak take theirs,
// it creates the owner itself, for automated deploys. Both are ignored once the Organization
// exists. A forgotten password is reset with a command run with database access, as with Grafana's
// `grafana cli admin reset-admin-password` and GitLab's `gitlab:password:reset`.

/** How long a setup link works: the operator opens it soon after starting the hub. */
const SETUP_LINK_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** The owner to create, from `ADMIN_EMAIL` and `ADMIN_PASSWORD`. */
export interface OwnerSettings {
  email?: string | undefined;
  password?: string | undefined;
}

/**
 * Sets the hub up unless its Organization exists: from `owner` when both its settings are given,
 * else by printing a setup link to the hub at `hubUrl` through `log`. Throws when only one of the
 * owner's settings is given, or when a link is needed and there is no `hubUrl` to make it from.
 */
export async function setUpOrganization(
  connectionString: string,
  { owner, hubUrl }: { owner: OwnerSettings; hubUrl: string | undefined },
  log: (message: string) => void = console.info,
): Promise<void> {
  await using db = openDatabase(connectionString);
  if (await findOrganization(db.withSchema(DB_SCHEMA))) {
    if (owner.email || owner.password) {
      log("The Organization exists, so ADMIN_EMAIL and ADMIN_PASSWORD are ignored");
    }
    return;
  }
  if (owner.email && owner.password) {
    const created = await createOrganization(db, {
      // The settings name no Organization, so it keeps the hub's default name.
      name: "Organization",
      owner: { email: owner.email, password: owner.password },
    });
    if (created === "created") log(`Created the Organization and its owner, ${owner.email}`);
    return;
  }
  if (owner.email || owner.password) {
    throw new Error(
      "Set both ADMIN_EMAIL and ADMIN_PASSWORD to create the owner from them, or neither to create the owner from a setup link",
    );
  }
  if (!hubUrl) {
    throw new Error(
      "Set HUB_URL to the hub's URL to print its setup link, or ADMIN_EMAIL and ADMIN_PASSWORD to create the owner from them",
    );
  }
  log(
    `The hub has no owner yet. Open this link to create one; it works once, within a day, and setting up again prints a new one:\n${await issueSetupLink(db, hubUrl)}`,
  );
}

/**
 * A new setup link to the dashboard at `hubUrl`. Its token comes after `#`, so it stays out of
 * request logs and `Referer` headers. Better Auth keeps one-time values such as its own reset
 * tokens in its `verification` table; the hub keeps the token there too, by its digest, as its
 * options have Better Auth hash identifiers that start with `SETUP_TOKEN_PREFIX`. Each run adds a
 * token rather than replacing the last: the newest is printed where the last was, so revoking that
 * one would add nothing.
 */
async function issueSetupLink(db: Kysely<Database>, hubUrl: string) {
  const token = generateRandomString(32);
  const context = await offlineAuth(db).$context;
  // The internal adapter is what Better Auth's own plugins use for their one-time values. Better
  // Auth documents it for plugin authors, not as a stable API: after an upgrade, check that
  // `createVerificationValue` and `consumeVerificationValue` keep their behaviour, which the setup
  // tests exercise.
  await context.internalAdapter.createVerificationValue({
    identifier: SETUP_TOKEN_PREFIX + token,
    value: "setup",
    expiresAt: new Date(Date.now() + SETUP_LINK_LIFETIME_MS),
  });
  return `${dashboardUrl(hubUrl, "setup").href}#${token}`;
}

/**
 * Creates the Organization named `name` and its owner, using up the setup link's `token` when
 * given, in one transaction: a failure, such as a password Better Auth refuses, leaves no owner
 * behind and the link usable. Of two setups at once, the Organization's unique slug lets one through, and the
 * other finds the hub set up. Better Auth's refusals are thrown as its `APIError`s.
 */
export async function createOrganization(
  db: Kysely<Database>,
  { name, owner }: { name: string; owner: { email: string; password: string } },
  token?: string,
): Promise<"created" | "alreadySetUp" | "linkRefused"> {
  try {
    return await db.transaction().execute(async (transaction) => {
      if (await findOrganization(transaction.withSchema(DB_SCHEMA))) return "alreadySetUp";
      const auth = offlineAuth(transaction, {
        // Public sign-up stays off; only this instance may sign up the owner.
        disableSignUp: false,
        autoSignIn: false,
      });
      if (token !== undefined) {
        const context = await auth.$context;
        // See `issueSetupLink` on the internal adapter. Consuming is atomic, so a token works once.
        const consumed = await context.internalAdapter.consumeVerificationValue(
          SETUP_TOKEN_PREFIX + token,
        );
        if (!consumed) return "linkRefused";
      }
      const { user } = await auth.api.signUpEmail({
        body: { email: owner.email, password: owner.password, name: "Owner" },
      });
      await auth.api.createOrganization({
        // One Organization per deployment (ADR 0007), so the slug Better Auth requires is fixed.
        body: { name, slug: "organization", userId: user.id },
      });
      return "created";
    });
  } catch (error) {
    if (await findOrganization(db.withSchema(DB_SCHEMA))) return "alreadySetUp";
    throw error;
  }
}

/** Sets a new password for the member with `email`, for a member who has forgotten theirs. */
export async function resetPassword(
  connectionString: string,
  member: { email: string; password: string },
) {
  await using db = openDatabase(connectionString);
  // Better Auth resets a password with a token it would email; this instance keeps the token instead.
  let token: string | undefined;
  const auth = offlineAuth(db, {
    sendResetPassword: async (data) => {
      token = data.token;
    },
  });
  await auth.api.requestPasswordReset({ body: { email: member.email } });
  if (!token) throw new Error(`No member has the email ${member.email}`);
  await auth.api.resetPassword({ body: { newPassword: member.password, token } });
}

/** Better Auth for setup and recovery, with the hub's options and `emailAndPassword` overrides. */
function offlineAuth(
  db: Kysely<Database>,
  emailAndPassword: Partial<NonNullable<BetterAuthOptions["emailAndPassword"]>> = {},
) {
  const options = offlineAuthOptions(db);
  return betterAuth({
    ...options,
    emailAndPassword: { ...options.emailAndPassword, ...emailAndPassword },
  });
}
