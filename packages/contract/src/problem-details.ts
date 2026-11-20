import { COMMON_ERROR_STATUS_MAP, ORPCError, onError, type ClientContext } from "@orpc/client";
import { getProcedureContractOrThrow, type SchemaIssue, type RouterContract } from "@orpc/contract";
import { ResponseValidationLinkPlugin } from "@orpc/contract/plugins";
import {
  decodeJsonPointerSegment,
  encodeJsonPointerSegment,
  SmartCoercionLinkPlugin,
} from "@orpc/json-schema";
import { getDynamicPathParams, getOpenAPIMeta, type OpenAPIMeta } from "@orpc/openapi";
import { OpenAPILink, type OpenAPILinkOptions } from "@orpc/openapi/fetch";
import { parse as parseContentType } from "content-type";
import statuses from "statuses";
import * as z from "zod/mini";

import { openOutputSchemaConverter } from "./json-schema.ts";

// The API's errors as RFC 9457 Problem Details (ADR 0023), as clients read them back into oRPC's
// errors; the hub produces them.

/** The content type of the API's errors. */
export const PROBLEM_DETAILS_CONTENT_TYPE = "application/problem+json; charset=utf-8";

// Response objects can gain members. Exclude only the other known locators in each variant.
const absent = z.optional(z.never());
const issueDetail = z.looseObject({
  detail: z.string(),
  pointer: absent,
  parameter: absent,
  header: absent,
});
const requestProblem = z.union([
  z.extend(issueDetail, {
    pointer: z.string().check(
      z.meta({
        format: "json-pointer",
        description:
          "Plain RFC 6901 pointer into the request body as the hub parses it (JSON or bracket-notation form data), including a missing member. The empty string names the whole body.",
      }),
    ),
  }),
  z.extend(issueDetail, {
    parameter: z.string().check(z.describe("OpenAPI path or query parameter name.")),
  }),
  z.extend(issueDetail, { header: z.string().check(z.describe("Request header name.")) }),
  issueDetail,
]);
export type RequestProblem = z.infer<typeof requestProblem>;

/** Locate validation issues in the request as it went over HTTP. */
export function requestProblemsFromIssues(
  route: OpenAPIMeta,
  issues: readonly SchemaIssue[],
): RequestProblem[] {
  const params = route.path && getDynamicPathParams(route.path);
  const bodyless = route.method === "GET" || route.method === "HEAD";
  return issues.map(({ message: detail, path }): RequestProblem => {
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
      if (bodyless) return { detail };
    }
    if (route.requestBodyHint !== undefined && route.requestBodyHint !== "json") return { detail };
    return {
      detail,
      pointer: tokens.map((token) => "/" + encodeJsonPointerSegment(String(token))).join(""),
    };
  });
}

/** Restore the procedure input paths that oRPC's form helpers match. */
function issuesFromRequestProblems(
  route: OpenAPIMeta | undefined,
  entries: RequestProblem[],
): SchemaIssue[] {
  const detailed = route?.inputStructure === "detailed";
  return entries.map((entry) => {
    const message = entry.detail;
    if (entry.pointer !== undefined) {
      const segments = entry.pointer.split("/").slice(1).map(decodeJsonPointerSegment);
      return { message, path: detailed ? ["body", ...segments] : segments };
    }
    if (entry.parameter !== undefined) {
      const name = entry.parameter;
      if (!detailed) return { message, path: [name] };
      const params = route.path && getDynamicPathParams(route.path);
      return {
        message,
        path: [
          params?.some(({ parameterName }) => parameterName === name) ? "params" : "query",
          name,
        ],
      };
    }
    if (entry.header !== undefined && detailed) return { message, path: ["headers", entry.header] };
    return { message };
  });
}

/** An error as the API answers it: a Problem Details document, which RFC 9457 lets carry more members. */
export const problemDetailsSchema = z
  .looseObject({
    /** Always `about:blank`: a client reads any problem by its status (ADR 0023). */
    type: z.string(),
    /** The status's reason phrase, such as "Not Found". */
    title: z.string(),
    status: z.int(),
    /** What went wrong, when it says more than the title. */
    detail: z.optional(z.string()),
    errors: z.optional(
      z
        .array(requestProblem)
        .check(
          z.minLength(1),
          z.describe(
            "All issues found at the failing check, when at least one has a request location.",
          ),
        ),
    ),
  })
  .register(z.globalRegistry, { id: "ProblemDetails" });
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;

/** The oRPC code for `status`, such as `NOT_FOUND` for 404. */
export function errorCodeOf(status: number): string {
  return (
    Object.entries(COMMON_ERROR_STATUS_MAP).find(([, codeStatus]) => codeStatus === status)?.[0] ??
    String(status)
  );
}

/** The API's error codes and HTTP statuses, including numeric codes for errors oRPC has no name for. */
export const errorStatusMap: Record<string, number> = {
  ...COMMON_ERROR_STATUS_MAP,
  ...Object.fromEntries(
    statuses.codes.filter((status) => status >= 400).map((status) => [status, status]),
  ),
};

/**
 * The Problem Details an error from the API carries, which the link below keeps as the error's
 * cause; an error oRPC raises itself, such as an answer the contract does not allow, has none.
 */
export function problemOf(error: unknown): ProblemDetails | undefined {
  if (!(error instanceof ORPCError)) return undefined;
  const problem = problemDetailsSchema.safeParse(error.cause);
  return problem.success ? problem.data : undefined;
}

/**
 * A link to the API at `contract` for oRPC's client. It reads Problem Details back into oRPC's errors
 * and checks every answer against the contract, which marks the errors the contract declares for a
 * call as typed. Values JSON cannot carry, such as dates, arrive as strings and are turned back into
 * the contract's types first.
 */
export function createProblemDetailsLink<T extends ClientContext>(
  contract: RouterContract,
  options: Omit<OpenAPILinkOptions<T>, "errorResponseBodyDecoder" | "errorResponseContentType">,
): OpenAPILink<T> {
  const send = options.fetch ?? ((url: string, init: RequestInit) => globalThis.fetch(url, init));
  return new OpenAPILink<T>(contract, {
    ...options,
    // An error page that is not Problem Details, as a proxy or gateway in front of the hub sends
    // while the hub restarts, in HTML or in JSON of its own, would fail to parse as the JSON the
    // contract says every body is, or as a problem, and lose its status; it reads as the problem
    // of its status, `about:blank`, as RFC 9457 has it for a problem that says no more than its
    // status, titled with its reason phrase, since HTTP/2 carries none of its own. The phrase comes
    // from jshttp's `statuses`, the table Node's own matches, which loads in browsers too; a status
    // it lacks, such as Cloudflare's 52x, is titled with its number. A problem is known by its
    // media type, which every error of the hub carries.
    fetch: async (url, init, clientOptions, path) => {
      const response = await send(url, init, clientOptions, path);
      if (response.ok) return response;
      const contentType = parseContentType(response.headers.get("content-type") ?? "");
      if (contentType.type === "application/problem+json") return response;
      await response.body?.cancel();
      const title = statuses.message[response.status] ?? String(response.status);
      return Response.json(
        { type: "about:blank", title, status: response.status },
        {
          status: response.status,
          statusText: response.statusText,
          headers: { "content-type": PROBLEM_DETAILS_CONTENT_TYPE },
        },
      );
    },
    // oRPC's client reads only `application/json` as JSON by itself, errors included.
    errorResponseContentType: PROBLEM_DETAILS_CONTENT_TYPE,
    errorResponseBodyDecoder: (body, _response, defaultError) => {
      const problem = problemDetailsSchema.safeParse(body);
      if (!problem.success) return defaultError();
      const { status, title, detail } = problem.data;
      // The document itself is kept as the cause, for a client that shows it as the hub sent it.
      return new ORPCError(errorCodeOf(status), { message: detail ?? title, cause: problem.data });
    },
    // The body decoder has no procedure. The link interceptor knows the call path, so it can
    // restore the input paths oRPC's form helpers read while keeping the wire document as cause.
    interceptors: [
      ...(options.interceptors ?? []),
      onError((error, { path }) => {
        if (!(error instanceof ORPCError)) return;
        const entries = problemOf(error)?.errors;
        if (!entries) return;
        const route = getOpenAPIMeta(getProcedureContractOrThrow(contract, path));
        error.data = { issues: issuesFromRequestProblems(route, entries) };
      }),
    ],
    plugins: [
      ...(options.plugins ?? []),
      new ResponseValidationLinkPlugin(contract),
      // oRPC's Zod converter is what describes a date as one; Zod's own JSON Schema has no dates.
      new SmartCoercionLinkPlugin(contract, { converters: [openOutputSchemaConverter] }),
    ],
  });
}
