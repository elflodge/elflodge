import { ValidationError } from "@orpc/server";
import { Data } from "effect";

/** What is wrong with one field of an input: a message, at the path of the field. */
export interface InputProblem {
  message: string;
  path: readonly (string | number)[];
}

/** Input a module refuses as the contract refuses invalid input, with each problem's path. */
export class InvalidInput extends Data.TaggedError("InvalidInput")<{
  problems: readonly { message: string; path: (string | number)[] }[];
}> {}

/**
 * `problems` with an input, raised as oRPC raises invalid input, so the answer lists them as it lists
 * the contract's own: for what the contract's schemas cannot check, such as an Output contract's
 * schema or the hub's maximums for limits.
 */
export function invalidInput<E>(
  errors: { BAD_REQUEST: (options: { cause: ValidationError }) => E },
  input: unknown,
  problems: readonly InputProblem[],
) {
  const cause = new ValidationError({
    message: "Input validation failed",
    issues: problems,
    invalidData: input,
  });
  return errors.BAD_REQUEST({ cause });
}
