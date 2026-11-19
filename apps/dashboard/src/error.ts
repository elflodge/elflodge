import ensureError from "ensure-error";

/** Preserve an Error's cause, including the Problem Details oRPC keeps there. */
export function asError(caught: unknown): Error {
  return caught instanceof Error ? caught : ensureError(caught);
}
