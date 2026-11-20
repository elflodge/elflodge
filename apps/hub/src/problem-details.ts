import { getOpenAPIMeta } from "@orpc/openapi";
import {
  DEFAULT_ERROR_STATUS,
  onError,
  ORPCError,
  ValidationError,
  type AnyORPCError,
} from "@orpc/server";
import type { StandardHandlerInterceptor } from "@orpc/server/standard";
import { getOwn } from "@orpc/shared";
import {
  errorStatusMap,
  requestProblemsFromIssues,
  problemDetailsSchema,
  type RequestProblem,
} from "contract";
import { problemDetails, type ProblemDetails } from "hono-problem-details";
import { prettifyError } from "zod/mini";

import { InvalidInput } from "./invalid-input.ts";

// The API's errors as RFC 9457 Problem Details (ADR 0023): oRPC's errors through the handler's
// encoder here, and errors outside oRPC through the same library's handler in the app.

export const locateRequestProblems: StandardHandlerInterceptor<object> = onError(
  (error, options) => {
    if (
      !(error instanceof ORPCError) ||
      (error.code !== "BAD_REQUEST" && error.code !== "UNPROCESSABLE_CONTENT")
    )
      return;
    // Module refusals with their own public detail carry the paths as InvalidInput. A
    // ValidationError would replace that detail with Zod's formatted issue list.
    const issues =
      error.cause instanceof ValidationError
        ? error.cause.issues
        : error.cause instanceof InvalidInput
          ? error.cause.problems
          : undefined;
    const route = getOpenAPIMeta(options.procedure);
    if (!issues || !route?.path) return;
    const entries = requestProblemsFromIssues(route, issues);
    if (entries.some((entry) => "pointer" in entry || "parameter" in entry || "header" in entry))
      error.data = { errors: entries };
  },
);

export function toProblemDetails(
  error: AnyORPCError,
): ProblemDetails & { errors?: RequestProblem[] } {
  // No contract error declares data. Only the request validation interceptor supplies errors.
  const errors = problemDetailsSchema.shape.errors.safeParse(error.data?.errors);
  const { problemDetails: document } = problemDetails({
    status: statusOf(error.code),
    detail: detailOf(error),
  });
  return errors.success && errors.data ? { ...document, errors: errors.data } : document;
}

/** The status oRPC's handler answers `code` with, including its default for codes it does not know. */
function statusOf(code: string): number {
  return getOwn(errorStatusMap, code) ?? DEFAULT_ERROR_STATUS;
}

/**
 * What a caller learns beyond the status. Invalid input lists its problems, one per line in Zod's
 * format, as oRPC's recipe shows. Otherwise only errors the contract declares for the call are
 * public, and only with a message of their own; anything else, such as the hub's own output failing
 * its schema, answers with its title alone.
 */
function detailOf(error: AnyORPCError): string | undefined {
  if (error.code === "BAD_REQUEST" && error.cause instanceof ValidationError) {
    return prettifyError(error.cause);
  }
  // An error created without a message carries oRPC's default for its code, which the title says.
  const hasOwnMessage = error.message !== new ORPCError(error.code).message;
  return error.defined && hasOwnMessage ? error.message : undefined;
}
