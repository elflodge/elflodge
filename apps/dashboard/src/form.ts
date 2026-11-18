/** The text a form's field `name` holds when submitted, or "" when it has none. */
export function fieldText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/** What the hub accepts as a new password: Better Auth's default lengths, which the hub keeps. */
export const NEW_PASSWORD = { minlength: 8, maxlength: 128 } as const;

/**
 * What the hub accepts as a name a person gives: it trims the name and refuses an empty one, so the
 * field refuses a name of spaces alone. The browser shows `title` when it refuses.
 */
export const GIVEN_NAME = {
  pattern: String.raw`.*\S.*`,
  title: "At least one character that is not a space",
} as const;
