import { type Kysely, sql } from "kysely";

// An Organization must keep an owner. Better Auth checks before writing, so two owners can both
// pass its check. The Organization lock makes the writes take turns and the following read sees
// the winner at READ COMMITTED, Postgres's default, which neither the hub nor Better Auth's
// adapter overrides. At REPEATABLE READ that read would still see the earlier snapshot.
// The loser receives HTTP 500 from Better Auth because translating the violation would require
// wrapping its adapter or rewriting its responses, for a race the database already makes safe.
export async function up(db: Kysely<unknown>): Promise<void> {
  // Better Auth stores trimmed, non-empty role names joined by commas.
  await sql`create function elflodge.has_owner_role(roles text) returns boolean
    language sql immutable strict parallel safe
    return 'owner' = any(string_to_array(roles, ','))`.execute(db);
  await sql`create function elflodge.keep_an_owner() returns trigger language plpgsql as $$
    begin
      perform 1 from elflodge.organization where id = old."organizationId" for update;
      if found and not exists (
        select 1 from elflodge.member where "organizationId" = old."organizationId"
        and elflodge.has_owner_role(role)
      ) then
        raise exception 'The Organization must keep an owner'
          using errcode = '23514';
      end if;
      return null;
    end $$`.execute(db);
  await sql`create trigger member_keeps_an_owner after delete or update of role on elflodge.member
    for each row when (elflodge.has_owner_role(old.role))
    execute function elflodge.keep_an_owner()`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop trigger member_keeps_an_owner on elflodge.member`.execute(db);
  await sql`drop function elflodge.keep_an_owner()`.execute(db);
  await sql`drop function elflodge.has_owner_role(text)`.execute(db);
}
