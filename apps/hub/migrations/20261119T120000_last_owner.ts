import { type Kysely, sql } from "kysely";

// An Organization must keep an owner. Better Auth checks before writing, so two owners can both
// pass its check. The Organization lock makes the writes take turns and the following read sees
// the winner at READ COMMITTED, Postgres's default, which neither the hub nor Better Auth's
// adapter overrides. At REPEATABLE READ that read would still see the earlier snapshot.
// During the Workers maintenance window (ADR 0047), the previous Worker can still admit a
// signed-in recipient under its native invitation rules, even if the inviter has lost authority.
// That version can already grant this membership. The new hub accepts existing memberships and
// applies the current-authority check as it takes over. The trigger guards both versions' writes.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create function elflodge.has_owner_role(roles text) returns boolean
    language sql immutable strict parallel safe
    return 'owner' = any(regexp_split_to_array(trim(roles), '[[:space:]]*,[[:space:]]*'))`.execute(
    db,
  );
  await sql`create function elflodge.keep_an_owner() returns trigger language plpgsql as $$
    begin
      perform 1 from elflodge.organization where id = old."organizationId" for update;
      if found and not exists (
        select 1 from elflodge.member where "organizationId" = old."organizationId"
        and elflodge.has_owner_role(role)
      ) then
        raise exception 'The Organization must keep an owner'
          using errcode = '23514', constraint = 'member_keeps_an_owner';
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
