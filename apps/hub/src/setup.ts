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

/**
 * How long a setup link works: the operator opens it soon after starting the hub, and a day, as
 * kubeadm gives the bootstrap token that joins a node, also covers an overnight pause.
 */
const SETUP_LINK_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * The advisory lock under which a link is issued, in Postgres's two-key form: the first key spells
 * "elfl" in ASCII, to keep apart from software sharing the database (ADR 0014), the second names the
 * lock among the hub's.
 */
const SETUP_LINK_LOCK = [0x65_6c_66_6c, 1] as const;

/** The `value` of a setup link's `verification` row, by which a new link revokes older ones. */
const SETUP_LINK_VALUE = "hub-setup";

/** The owner to create, from `ADMIN_EMAIL` and `ADMIN_PASSWORD`. */
export interface OwnerSettings {
  email?: string | undefined;
  password?: string | undefined;
}

/**
 * Sets the hub up unless its Organization exists: from `owner` when both its settings are given,
 * else by printing a setup link to the hub at `hubUrl` through `log`. Throws when only one of the
 * owner's settings is given, or when a link is needed and there is no `hubUrl` to make it from, or
 * `log` must not print one, for the reason `noLinkReason` gives.
 */
export async function setUpOrganization(
  connectionString: string,
  {
    owner,
    hubUrl,
    noLinkReason,
  }: { owner: OwnerSettings; hubUrl: string | undefined; noLinkReason?: string },
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
    const created = await createOwnerAndOrganization(db, {
      // The settings name no Organization, so it keeps the hub's default name.
      name: "Organization",
      // Nor the owner, who keeps a placeholder name.
      owner: { name: "Owner", email: owner.email, password: owner.password },
    });
    if (created === "created") log(`Created the Organization and its owner, ${owner.email}`);
    return;
  }
  if (owner.email || owner.password) {
    throw new Error(
      "Set both ADMIN_EMAIL and ADMIN_PASSWORD to create the owner from them, or neither to create the owner from a setup link",
    );
  }
  if (noLinkReason) throw new Error(noLinkReason);
  if (!hubUrl) {
    throw new Error(
      "Set HUB_URL to the hub's URL to print its setup link, or ADMIN_EMAIL and ADMIN_PASSWORD to create the owner from them",
    );
  }
  log(
    `The hub has no owner yet. Open this link to create one; it works once, within a day, and setting up again replaces it:\n${await issueSetupLink(db, hubUrl)}`,
  );
}

/**
 * A new setup link to the dashboard at `hubUrl`, which replaces any earlier one. Its token comes
 * after `#`, so it stays out of request logs and `Referer` headers. Better Auth keeps one-time
 * values such as its own reset tokens in its `verification` table; the hub keeps the token there
 * too, by its digest, as its options have Better Auth hash identifiers that start with
 * `SETUP_TOKEN_PREFIX`.
 */
async function issueSetupLink(db: Kysely<Database>, hubUrl: string) {
  // 32 characters, as Better Auth's one-time-token plugin makes its tokens.
  const token = generateRandomString(32);
  // Made first, so a `hubUrl` it cannot parse revokes no link.
  const link = `${dashboardUrl(hubUrl, "setup").href}#${token}`;
  await db.transaction().execute(async (transaction) => {
    // Two issues at once, such as two runs of `vp run setup`, would each delete before the other
    // inserts and leave both links working, so they take turns.
    await transaction
      .selectNoFrom((eb) =>
        eb
          .fn(
            "pg_advisory_xact_lock",
            SETUP_LINK_LOCK.map((key) => eb.lit(key)),
          )
          .as("locked"),
      )
      .execute();
    // Better Auth documents its internal adapter for request contexts. Setup reaches that adapter
    // through `auth.$context` outside a request, an undocumented use. After an upgrade, check that
    // `adapter.deleteMany` revokes earlier links by value, `internalAdapter.createVerificationValue`
    // stores the new link, `consumeVerificationValue` consumes it atomically, and
    // `verification.storeIdentifier` still matches its overrides by prefix. The setup tests exercise
    // these paths. Check separately that `findUserByEmail` still recovers an owner left by an
    // interrupted setup in 0.10.0 or earlier.
    const context = await offlineAuth(transaction).$context;
    // Earlier links have unknown tokens, but all share the setup verification value.
    await context.adapter.deleteMany({
      model: "verification",
      where: [{ field: "value", value: SETUP_LINK_VALUE }],
    });
    await context.internalAdapter.createVerificationValue({
      identifier: SETUP_TOKEN_PREFIX + token,
      value: SETUP_LINK_VALUE,
      expiresAt: new Date(Date.now() + SETUP_LINK_LIFETIME_MS),
    });
  });
  return link;
}

/**
 * Creates the owner and the Organization named `name`, using up the setup link's `token` when
 * given, in one transaction: a failure, such as a password Better Auth refuses, leaves no owner
 * behind and the link usable. Of two setups at once, one gets through and the other, held by the
 * link's row or the database's unique keys until the first commits, finds the hub set up. Better
 * Auth's refusals are thrown as its `APIError`s.
 *
 * Better Auth has no way to join a transaction it did not open (better-auth/better-auth#10609), so
 * an instance is built on this one. Setup disables Better Auth's own transactions because an
 * open Kysely transaction cannot start another.
 */
export async function createOwnerAndOrganization(
  db: Kysely<Database>,
  { name, owner }: { name: string; owner: { name: string; email: string; password: string } },
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
      const context = await auth.$context;
      if (token !== undefined) {
        // See `issueSetupLink` on the internal adapter. Consuming is atomic, so a token works once.
        const consumed = await context.internalAdapter.consumeVerificationValue(
          SETUP_TOKEN_PREFIX + token,
        );
        if (!consumed) {
          // A competing setup using the same link may have committed while this one waited.
          const organization = await findOrganization(transaction.withSchema(DB_SCHEMA));
          return organization ? "alreadySetUp" : "linkRefused";
        }
      }
      // Up to 0.10.0, the hub created the owner and the Organization in two steps, so a start
      // stopped in between left the owner's `user` row behind, which its settings now claim.
      const userId =
        (token === undefined
          ? (await context.internalAdapter.findUserByEmail(owner.email))?.user.id
          : undefined) ??
        (
          await auth.api.signUpEmail({
            body: { email: owner.email, password: owner.password, name: owner.name },
          })
        ).user.id;
      await auth.api.createOrganization({
        // One Organization per deployment (ADR 0007), so the slug Better Auth requires is fixed.
        body: { name, slug: "organization", userId },
      });
      return "created";
    });
  } catch (error) {
    // After rollback, check whether a competing setup committed.
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
