import { type Kysely, sql } from "kysely";

// A member may submit with their session as a key does (ADR 0045), so a Batch, a job and a Usage
// record each record who submitted it as a kind and an ID, as the API shows a submitter:
// `submitterKind`, `key` for the API key it was sent with or `member` for the member whose
// session sent it, and `submitterId`, the key's ID or the member's user ID. Rows written before
// were all a key's, so the kind's default fills them and is then dropped, leaving every writer to
// give it. `submitterName` is the key's or the member's name as it was at submission: null for a
// key without a name, which Better Auth allows; a member always has one. `keyCreatorUserId`, which
// held the user who created the key under a name that called it a member, is null when a member
// submitted. The IDs are copied rather than referenced: Better Auth deletes a key's row when the
// key is revoked, and a user's ID is copied alike, though the hub deletes no user, as Better Auth's
// account deletion is off. Kysely runs the pending migrations in one transaction, so the renames
// apply with the rest; the CHECKs name only `key`, so a kind added later, which Postgres cannot use
// in the transaction that adds it, needs no change to them.
const TABLES = ["batch", "job", "usageRecord"] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  const schema = db.schema.withSchema("elflodge");
  await schema.createType("submitterKind").asEnum(["key", "member"]).execute();
  for (const table of TABLES) {
    await schema.alterTable(table).renameColumn("submitterKeyId", "submitterId").execute();
    await schema.alterTable(table).renameColumn("submitterKeyName", "submitterName").execute();
    await schema.alterTable(table).renameColumn("submitterMemberId", "keyCreatorUserId").execute();
    await schema
      .alterTable(table)
      .addColumn("submitterKind", sql`elflodge."submitterKind"`, (col) =>
        col.notNull().defaultTo("key"),
      )
      .alterColumn("keyCreatorUserId", (col) => col.dropNotNull())
      .execute();
    await schema
      .alterTable(table)
      .alterColumn("submitterKind", (col) => col.dropDefault())
      .execute();
    await schema
      .alterTable(table)
      .addCheckConstraint(
        `${table}_keyCreatorUserId_check`,
        sql`("keyCreatorUserId" is not null) = ("submitterKind" = 'key')`,
      )
      .execute();
    await schema
      .alterTable(table)
      .addCheckConstraint(
        `${table}_submitterName_check`,
        sql`"submitterKind" = 'key' or "submitterName" is not null`,
      )
      .execute();
  }
}

// Fails while a member's submission is stored, which the earlier columns cannot hold.
export async function down(db: Kysely<unknown>): Promise<void> {
  const schema = db.schema.withSchema("elflodge");
  for (const table of TABLES) {
    for (const check of ["keyCreatorUserId", "submitterName"]) {
      await schema.alterTable(table).dropConstraint(`${table}_${check}_check`).execute();
    }
    await schema
      .alterTable(table)
      .alterColumn("keyCreatorUserId", (col) => col.setNotNull())
      .dropColumn("submitterKind")
      .execute();
    await schema.alterTable(table).renameColumn("keyCreatorUserId", "submitterMemberId").execute();
    await schema.alterTable(table).renameColumn("submitterName", "submitterKeyName").execute();
    await schema.alterTable(table).renameColumn("submitterId", "submitterKeyId").execute();
  }
  await schema.dropType("submitterKind").execute();
}
