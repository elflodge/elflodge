import ensureError from "ensure-error";

/** Preserve an Error's cause, including oRPC's response with the Hub's Problem Details. */
export function asError(caught: unknown): Error {
  return caught instanceof Error ? caught : ensureError(caught);
}
