import { type Kysely, sql } from "kysely";

// An Organization must keep an owner. Better Auth checks before writing, so two owners can both
// pass its check. The Organization lock makes the writes take turns and the following read sees
// the winner at READ COMMITTED, Postgres's default, which neither the hub nor Better Auth's
// adapter overrides. At REPEATABLE READ that read would still see the earlier snapshot.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create function elflodge.keep_an_owner() returns trigger language plpgsql as $$
    begin
      perform 1 from elflodge.organization where id = old."organizationId" for update;
      if found and not exists (
        select 1 from elflodge.member where "organizationId" = old."organizationId"
        and 'owner' = any(regexp_split_to_array(trim(role), '[[:space:]]*,[[:space:]]*'))
      ) then
        raise exception 'The Organization must keep an owner'
          using errcode = '23514', constraint = 'member_keeps_an_owner';
      end if;
      return null;
    end $$`.execute(db);
  await sql`create trigger member_keeps_an_owner after delete or update of role on elflodge.member
    for each row when ('owner' = any(regexp_split_to_array(trim(old.role), '[[:space:]]*,[[:space:]]*')))
    execute function elflodge.keep_an_owner()`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop trigger member_keeps_an_owner on elflodge.member`.execute(db);
  await sql`drop function elflodge.keep_an_owner()`.execute(db);
}
