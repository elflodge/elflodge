import { expressionBuilder, type Expression } from "kysely";

/** The role names Better Auth stores together in a membership or invitation. */
export function storedRoles(role: Expression<string | null>) {
  const eb = expressionBuilder();
  return eb.fn<string[]>("string_to_array", [role, eb.val(",")]);
}

export function hasOwnerRole(role: Expression<string | null>) {
  const eb = expressionBuilder();
  return eb(eb.val("owner"), "=", eb.fn.any(storedRoles(role)));
}
