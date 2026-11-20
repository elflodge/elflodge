import { getOpenAPIMeta, getDynamicPathParams } from "@orpc/openapi";
import { DEFAULT_ERROR_STATUS, ORPCError, ValidationError, type AnyORPCError } from "@orpc/server";
import type { StandardHandlerInterceptor } from "@orpc/server/standard";
import { getOwn } from "@orpc/shared";
import { errorStatusMap, type ProblemDetails, type RequestProblem } from "contract";
import * as JsonPointer from "effect/JsonPointer";
import { problemDetails } from "hono-problem-details";
import { prettifyError } from "zod/mini";

import { InvalidInput } from "./invalid-input.ts";

// The API's errors as RFC 9457 Problem Details (ADR 0023): oRPC's errors through the handler's
// encoder here, and errors outside oRPC through the same library's handler in the app.

// The handler's encoder receives the same error after the interceptor, without its procedure.
const requestProblems = new WeakMap<AnyORPCError, RequestProblem[]>();

export const locateRequestProblems: StandardHandlerInterceptor<object> = async (options) => {
  try {
    return await options.next();
  } catch (error) {
    if (
      !(error instanceof ORPCError) ||
      (error.code !== "BAD_REQUEST" && error.code !== "UNPROCESSABLE_CONTENT")
    )
      throw error;
    const issues =
      error.cause instanceof ValidationError
        ? error.cause.issues
        : error.cause instanceof InvalidInput
          ? error.cause.problems
          : undefined;
    const route = getOpenAPIMeta(options.procedure);
    if (!issues || !route?.path) throw error;
    const params = getDynamicPathParams(route.path);
    const bodyless = route.method === "GET" || route.method === "HEAD";
    const entries = issues.map(({ message: detail, path }): RequestProblem => {
      if (!path) return { detail };
      const tokens = path.map((segment) => (typeof segment === "object" ? segment.key : segment));
      if (tokens.some((token) => typeof token === "symbol")) return { detail };
      const [first, second] = tokens;
      if (route.inputStructure === "detailed") {
        if (first === "headers" && typeof second === "string") return { detail, header: second };
        if ((first === "params" || first === "query") && typeof second === "string")
          return { detail, parameter: second };
        if (first !== "body") return { detail };
        tokens.shift();
      } else {
        if (
          typeof first === "string" &&
          (bodyless || params?.some(({ parameterName }) => parameterName === first))
        )
          return { detail, parameter: first };
        if (bodyless || (!tokens.length && params?.length)) return { detail };
      }
      return {
        detail,
        pointer: tokens.map((token) => "/" + JsonPointer.escapeToken(String(token))).join(""),
      };
    });
    if (entries.some((entry) => "pointer" in entry || "parameter" in entry || "header" in entry))
      requestProblems.set(error, entries);
    throw error;
  }
};

export function toProblemDetails(error: AnyORPCError): ProblemDetails {
  const errors = requestProblems.get(error);
  const { problemDetails: document } = problemDetails({
    status: statusOf(error.code),
    detail: detailOf(error),
  });
  return errors ? { ...document, errors } : { ...document };
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
