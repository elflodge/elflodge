import { defineMeta, error, oc } from "@orpc/contract";
import { openapi } from "@orpc/openapi";
import { en } from "zod/locales";
import * as z from "zod/mini";

// What every procedure of the API and of the Runner protocol is built from: the errors they share,
// the builder and who may make a call.

// `zod/mini` leaves messages out unless asked; without them every problem reads "Invalid input".
z.config(en());

/**
 * The permissions a call can require of an API key, by resource: `register` for the shared key
 * Runners start with, `actAs` for a Runner's own key, acting as that Runner over the socket and its
 * HTTP calls, `read` for the Runner listing, and the job calls. The hub's access control holds them
 * among its statements.
 */
export const KEY_PERMISSIONS = {
  runner: ["register", "actAs", "read"],
  job: ["create", "read", "pause", "resume", "cancel", "delete"],
} as const;

/** The actions a member can grant. Only the hub issues a Runner's own actAs key. */
export const GRANTABLE_KEY_PERMISSIONS = {
  job: KEY_PERMISSIONS.job,
  runner: ["register", "read"],
} as const satisfies {
  [K in keyof typeof KEY_PERMISSIONS]: readonly (typeof KEY_PERMISSIONS)[K][number][];
};

/** Actions of one resource of `KEY_PERMISSIONS` a call requires, such as `{ job: ["pause"] }`. */
export type KeyPermissions = {
  [Resource in keyof typeof KEY_PERMISSIONS]: {
    [Only in Resource]: (typeof KEY_PERMISSIONS)[Resource][number][];
  };
}[keyof typeof KEY_PERMISSIONS];

/** A call made without a valid session, or without an API key holding the permission it needs. */
export const Unauthorized = error("UNAUTHORIZED");
/**
 * A call refused to a signed-in account: one that is not a member of the Organization, such as one
 * removed from it, or a member whose role does not allow the call.
 */
export const Forbidden = error("FORBIDDEN");
/** A call that acts for the Organization, made before the hub is set up. */
export const HubNotSetUp = error("SERVICE_UNAVAILABLE", { message: "The hub is not set up" });
/** A call naming a Runner, an API key or a job the hub does not have. */
export const NotFound = error("NOT_FOUND");

/**
 * Every HTTP call, the API's and the Runner's, that needs a caller. Every call says who may make it
 * (`byKey`, or `byMember` or `byKeyOrMember` on `forMembers`), and the hub refuses anyone else
 * with `UNAUTHORIZED`, or a signed-in account that is not a member with `FORBIDDEN`.
 */
export const api = oc.errors({ [Unauthorized.code]: Unauthorized });
/** The calls anyone may make (`byAnyone`), which the hub never refuses as `UNAUTHORIZED`. */
export const forAnyone = oc;
/**
 * How the OpenAPI document describes an API key, sent in `x-api-key`. A call's security lists the
 * permissions the key needs as role names.
 */
export const API_KEY_SECURITY_SCHEME = {
  type: "apiKey",
  in: "header",
  name: "x-api-key",
  description:
    "An API key, sent in `x-api-key`. A call lists the permissions the key needs as `resource:action`, all of them required. A call that also takes a member's session checks the key whenever one is sent, whatever session the request carries.",
} as const;

/**
 * Who may make a call: with an API key holding the permissions in `key`, as a signed-in member,
 * either, or `anyone`, without either. The hub checks it before every call, and the OpenAPI
 * document gives it as the call's `security`.
 */
export interface Access {
  key?: KeyPermissions;
  member?: true;
  anyone?: true;
}

const [accessMeta, getAccess] = defineMeta("access", (incoming: Access) => incoming);
/** The access a procedure declares; the hub refuses to run a procedure that declares none. */
export { getAccess };

/** A key's permissions as OpenAPI role names, `resource:action`, such as `job:pause`. */
function roleNamesOf(permissions: KeyPermissions) {
  return Object.entries<string[]>(permissions).flatMap(([resource, actions]) =>
    actions.map((action) => `${resource}:${action}`),
  );
}

/**
 * Declares who may make a call, as the hub's access and as the OpenAPI document's `security`, where
 * an API key (`apiKey`) and a signed-in member (`session`, the hub's session cookie, which the hub
 * names for its deployment) are alternatives.
 */
function calledBy(access: Access) {
  const security: Record<string, string[]>[] = [];
  if (access.key) security.push({ apiKey: roleNamesOf(access.key) });
  if (access.member) security.push({ session: [] });
  return [accessMeta(access), openapi.spec((operation) => ({ ...operation, security }))] as const;
}
export const byKey = (permissions: KeyPermissions) => calledBy({ key: permissions });
export const byMember = calledBy({ member: true });
export const byKeyOrMember = (permissions: KeyPermissions) =>
  calledBy({ key: permissions, member: true });
/** For the calls a hub answers before it has members, such as setting it up. */
export const byAnyone = calledBy({ anyone: true });

/** Calls that act for the Organization, which exists once the hub is set up. */
export const forOrganization = api.errors({ [HubNotSetUp.code]: HubNotSetUp });
/**
 * The calls a signed-in member may make (`byMember` or `byKeyOrMember`). On a member's session,
 * the hub answers 401 when there is no valid session, which signing in can fix, and 403 to an
 * account that is not a member, which signing in again cannot. An owner left by a setup that
 * stopped halfway in 0.10.0 or earlier, before the Organization existed, gets 503. On a call that
 * also takes a key (`byKeyOrMember`), a key sent with it is checked in place of the session, and
 * one not valid for the call gets 401.
 */
export const forMembers = forOrganization.errors({ [Forbidden.code]: Forbidden });
