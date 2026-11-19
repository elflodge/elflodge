import { createAuthClient } from "better-auth/client";
import { organizationClient } from "better-auth/client/plugins";
import ensureError from "ensure-error";

/**
 * Better Auth's client for the hub that serves the dashboard, at Better Auth's default path on the
 * page's own origin, the only one from which the hub signs members in (ADR 0015). Its framework-
 * neutral client, as its Solid adapter is built for Solid 1. Its organization plugin reads the
 * Organization.
 */
export const authClient = createAuthClient({ plugins: [organizationClient()] });

/** What the member reads when a request to the hub got no answer. */
export const CONNECTION_FAILED = "The connection to the hub failed. Please try again.";

/** A refusal or failure as Better Auth's client returns it. */
interface AuthError {
  /** Better Auth's name for the refusal, one of `authClient.$ERROR_CODES`, where it gave one. */
  code?: string | undefined;
  message?: string | undefined;
  statusText: string;
  status: number;
}

/** What went wrong with a request to Better Auth, in words for the member. */
export function failureMessage(error: AuthError): string {
  // A proxy's bodyless error, such as a 502, has neither a message nor, over HTTP/2, a status text.
  return error.message || error.statusText || `The hub answered with HTTP status ${error.status}.`;
}

/** What went wrong with a request to Better Auth: words for the member, and Better Auth's code. */
export interface AuthFailure {
  message: string;
  code?: string | undefined;
}

/**
 * Runs `operation`, a call of Better Auth's client that a form makes, with `setPending` true
 * meanwhile, and gives what went wrong, or `undefined` when it succeeded.
 */
export async function attemptAuth(
  operation: () => Promise<{ error: AuthError | null }>,
  setPending: (pending: boolean) => void,
): Promise<AuthFailure | undefined> {
  setPending(true);
  try {
    const { error } = await operation();
    return error ? { message: failureMessage(error), code: error.code } : undefined;
  } catch (error) {
    // Better Auth's client rejects, rather than returning an error, when a request gets no answer
    // or its answer's body cannot be read (better-auth/better-auth#11284); this can go once it
    // returns one. Logged, as a mistake in `operation` lands here too.
    console.error(ensureError(error));
    return { message: CONNECTION_FAILED };
  } finally {
    setPending(false);
  }
}

/** The error of a read of the hub that failed, which names `what` could not be read. */
export function unreadError(what: string, message: string): Error {
  return new Error(`${what} could not be read: ${message}`);
}

/**
 * The answer to `request`, a call of Better Auth's client, or, when it got none, the failure the
 * client would otherwise reject with (see `attemptAuth`), so that a read has one failure to name.
 */
export function answered<Answer>(
  request: Promise<Answer>,
): Promise<Answer | { data: null; error: AuthError }> {
  return request.catch((error: unknown) => {
    console.error(ensureError(error));
    return { data: null, error: { message: CONNECTION_FAILED, statusText: "", status: 0 } };
  });
}
