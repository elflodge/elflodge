import { APIError, BASE_ERROR_CODES } from "@better-auth/core/error";
import { toKebabCase } from "@better-auth/core/utils/string";
import {
  ProcedureContract,
  type AnySchema,
  type ErrorMap,
  type InferSchemaInput,
  type InferSchemaOutput,
  type ORPCErrorConstructorMap,
} from "@orpc/contract";
import { implement, ProcedureImplementer, type Router } from "@orpc/server";
import { getEndpoints } from "better-auth/api";
import { ORGANIZATION_ERROR_CODES } from "better-auth/client/plugins";
import { organization } from "better-auth/plugins";
import { apiContract } from "contract";
import { http, HttpResponse, type AnyHandler } from "msw";

import { createApiHandler } from "../../hub/src/api-handler.ts";
import { invalidInput, type InputProblem } from "../../hub/src/invalid-input.ts";
import type { authClient } from "../src/auth-client.ts";

// A stand-in for the hub at the HTTP boundary: each endpoint answers what the test arranged, and
// records what it was sent. Its API is one router built from the contract and served through the
// hub's own handlers, so the hub's routing picks the procedure and the hub's decoding, checks and
// Problem Details apply to each request and answer.

/** Better Auth's answer to a session read: who is signed in, or no one. */
export type Session = Awaited<ReturnType<typeof authClient.getSession>> | null;

/** Calls held until the test releases them. */
export interface Held<Input> {
  /** The input of the first call held. */
  readonly arrived: Promise<Input>;
  /**
   * Lets every held call go on to the answer arranged at that moment, and stops holding, so later
   * calls are answered at once.
   */
  release(): void;
}

/**
 * What a test arranges for one endpoint of the hub, and what it sees of its calls. An answer stands
 * for every call until the test arranges another, as the hub's data changes between steps.
 */
export interface Endpoint<Input, Output> {
  /** Answers every call with `output`, or with what `answer` returns for the call's input. */
  answers(output: Output | ((input: Input) => Output | Promise<Output>)): void;
  /** Fails every call with a 500, as the hub answers when something goes wrong in it. */
  fails(): void;
  /**
   * Loses every call's answer: the hub receives the call, and the page meets a network failure, as
   * when the connection drops before the answer arrives, so it cannot tell whether the hub acted.
   */
  drops(): void;
  /** Holds every call from now until the test releases them. */
  hold(): Held<Input>;
  /** The input of every call received, in order. */
  readonly calls: readonly Input[];
}

/** One of the hub's procedures, as its contract defines it. */
export interface Procedure<Input, Output, Errors extends ErrorMap> extends Endpoint<Input, Output> {
  /** Refuses every call with one of the errors the contract declares for it, as the hub writes it. */
  refuses<Code extends keyof Errors>(
    code: Code,
    ...options: Parameters<ORPCErrorConstructorMap<Errors>[Code]>
  ): void;
  /**
   * Refuses every call as invalid input, each of `problems` a message at the path of the field it is
   * about, as the hub refuses what its own checks find wrong beyond the contract's schemas.
   */
  refusesInput(problems: readonly InputProblem[]): void;
  /**
   * Answers every call with `body`, written as the hub writes an answer but not checked against the
   * contract, until the test arranges another answer: an answer from a hub of another version, or
   * a broken one.
   */
  answersUnchecked(body: unknown): void;
  /**
   * The input of every call received, in order. A request the hub's handlers refuse before the
   * procedure runs, such as one whose body is too large or whose input the contract refuses, gets
   * the hub's refusal, whatever the test arranged, and is not among them.
   */
  readonly calls: readonly Input[];
}

type Procedures<Contract> =
  Contract extends ProcedureContract<infer I, infer O, infer E>
    ? Procedure<InferSchemaOutput<I>, InferSchemaInput<O>, E>
    : { readonly [Key in keyof Contract]: Procedures<Contract[Key]> };

/** One of Better Auth's error codes, as the dashboard's client knows them. */
export type AuthErrorCode = keyof typeof authClient.$ERROR_CODES;

/** A status by the name Better Auth's routes refuse with, such as `"FORBIDDEN"`. */
export type AuthStatus = ConstructorParameters<typeof APIError>[0];

/** One of Better Auth's routes, as the dashboard's client calls it. */
export interface AuthRoute<Input, Output> extends Endpoint<Input, Output> {
  /** Refuses every call with `code` at `status`, as Better Auth's routes write a refusal. */
  refuses(status: AuthStatus, code: AuthErrorCode): void;
}

/**
 * What a call sends: its body, or for a read, its query, whose values arrive as the strings the
 * address carries.
 */
type RouteInput<Argument> = Argument extends { query?: infer Query }
  ? { query: { readonly [Key in keyof NonNullable<Query>]?: string } }
  : Omit<Argument, "fetchOptions">;

/**
 * Better Auth's routes, by the names of the client's calls, as `hub.auth.organization.removeMember`
 * for `authClient.organization.removeMember`; the session read is `hub.session`.
 */
export type AuthRoutes<Client> = {
  readonly [
    Key in keyof Client as Key extends `$${string}` | `use${string}` | "getSession" ? never : Key
  ]: Client[Key] extends (argument: infer Argument, ...rest: never[]) => Promise<infer Output>
    ? AuthRoute<RouteInput<NonNullable<Argument>>, Output>
    : AuthRoutes<Client[Key]>;
};

/** The hub as a test arranges it: every procedure of its API, by its path in the contract. */
export type Hub = Procedures<typeof apiContract> & {
  /** Better Auth's session read, which the signed-in shell makes on every navigation. */
  readonly session: Endpoint<void, Session>;
  /** Better Auth's other routes. */
  readonly auth: AuthRoutes<typeof authClient>;
};

/** The stand-in as the browser's network serves it. */
export interface HubNetwork {
  /** The handlers that serve it. */
  readonly handlers: readonly AnyHandler[];
  /** The calls the test arranged no answer for, each with its input. */
  readonly unarranged: readonly string[];
  /** Lets every held call go on, so that nothing waits once the test is over. */
  releaseAll(): void;
}

type Answer<Input, Output, Refuse> =
  | { kind: "output"; answer: (input: Input) => Output | Promise<Output> }
  | { kind: "refusal"; refuse: Refuse }
  | { kind: "failure" }
  | { kind: "loss" }
  | { kind: "invalidInput"; problems: readonly InputProblem[] }
  | { kind: "unchecked"; body: unknown };

/** What one endpoint was arranged to answer, and the calls it received. */
class Arrangement<Input, Output, Refuse> implements Endpoint<Input, Output> {
  answer: Answer<Input, Output, Refuse> | undefined;
  readonly calls: Input[] = [];
  #hold: { arrived: PromiseWithResolvers<Input>; gate: PromiseWithResolvers<void> } | undefined;

  answers(output: Output | ((input: Input) => Output | Promise<Output>)) {
    this.answer = { kind: "output", answer: isAnswerFunction(output) ? output : () => output };
  }

  fails() {
    this.answer = { kind: "failure" };
  }

  drops() {
    this.answer = { kind: "loss" };
  }

  hold(): Held<Input> {
    if (this.#hold) throw new Error("Its calls are held already");
    const hold = { arrived: Promise.withResolvers<Input>(), gate: Promise.withResolvers<void>() };
    this.#hold = hold;
    return {
      arrived: hold.arrived.promise,
      release: () => {
        if (this.#hold === hold) this.#hold = undefined;
        hold.gate.resolve();
      },
    };
  }

  release() {
    this.#hold?.gate.resolve();
    this.#hold = undefined;
  }

  /** Records a call, waits while calls are held, and returns the answer that stands then. */
  async receive(input: Input) {
    this.calls.push(input);
    const hold = this.#hold;
    if (hold) {
      hold.arrived.resolve(input);
      await hold.gate.promise;
    }
    return this.answer;
  }
}

// What a procedure answers is JSON, never a function.
function isAnswerFunction<Input, Output>(
  value: Output | ((input: Input) => Output | Promise<Output>),
): value is (input: Input) => Output | Promise<Output> {
  return typeof value === "function";
}

/** What the stand-in learns of one request while the hub's handler serves it. */
interface Exchange {
  /** Whether the answer is to be lost on its way back. */
  lost: boolean;
}

/** The context the stand-in's router is called with: the request's `Exchange`. */
interface StandInContext {
  exchange: Exchange;
}

/**
 * An answer that leaves the procedure past its output check: the stand-in's middleware returns its
 * `body` as the call's output, which oRPC checks only for what a procedure's handler returns.
 */
class UncheckedAnswer {
  readonly body: unknown;
  constructor(body: unknown) {
    this.body = body;
  }
}

class ContractProcedure<
  I extends AnySchema,
  O extends AnySchema,
  E extends ErrorMap,
> extends Arrangement<
  InferSchemaOutput<I>,
  InferSchemaInput<O>,
  (errors: ORPCErrorConstructorMap<E>) => Error
> {
  readonly #name: string;
  readonly #unarranged: string[];

  constructor(name: string, unarranged: string[]) {
    super();
    this.#name = name;
    this.#unarranged = unarranged;
  }

  refuses<Code extends keyof E>(
    code: Code,
    ...options: Parameters<ORPCErrorConstructorMap<E>[Code]>
  ) {
    this.answer = { kind: "refusal", refuse: (errors) => errors[code](...options) };
  }

  refusesInput(problems: readonly InputProblem[]) {
    this.answer = { kind: "invalidInput", problems };
  }

  answersUnchecked(body: unknown) {
    this.answer = { kind: "unchecked", body };
  }

  /** Answers a call whose input the contract accepted, as the test arranged. */
  async serve({
    input,
    errors,
    context,
  }: {
    input: InferSchemaOutput<I>;
    errors: ORPCErrorConstructorMap<E>;
    context: StandInContext;
  }): Promise<InferSchemaInput<O>> {
    if (!this.answer) {
      this.#unarranged.push(`${this.#name} with ${JSON.stringify(input)}`);
      throw new Error(`The test arranged no answer for ${this.#name}`);
    }
    const answer = await this.receive(input);
    switch (answer?.kind) {
      case "output":
        return answer.answer(input);
      case "refusal":
        throw answer.refuse(errors);
      case "invalidInput":
        throw invalidInput(errors, input, answer.problems);
      case "unchecked":
        throw new UncheckedAnswer(answer.body);
      case "loss":
        context.exchange.lost = true;
        throw new Error(`${this.#name}'s answer is lost, as the test arranged`);
      default:
        throw new Error(`${this.#name} fails, as the test arranged`);
    }
  }
}

type AnyProcedure = ContractProcedure<AnySchema, AnySchema, ErrorMap>;

/**
 * The implementer of the stand-in's procedures, each answering an `UncheckedAnswer` its handler
 * throws with its body. A middleware applied to the contract's implementer runs ahead of the
 * procedures' input and output checks, as the hub's access check does.
 */
const implementer = implement<typeof apiContract, StandInContext>(apiContract).use(
  async ({ next }, _input, output) => {
    try {
      return await next();
    } catch (error) {
      if (error instanceof UncheckedAnswer) return output({ output: error.body });
      throw error;
    }
  },
);

/**
 * One `ContractProcedure` for each procedure of `contract`, at its path, gathered in `procedures`,
 * and the router that serves them.
 */
function arrange<Contract>(
  contract: Contract,
  path: string[],
  procedures: AnyProcedure[],
  unarranged: string[],
): { hub: Procedures<Contract>; router: Router<StandInContext> };
// The contract's tree is walked at run time, which no type can follow; the overload above states
// what the walk builds.
function arrange(
  contract: unknown,
  path: string[],
  procedures: AnyProcedure[],
  unarranged: string[],
): { hub: unknown; router: unknown } {
  if (contract instanceof ProcedureContract) {
    const procedureImplementer = path.reduce<unknown>(
      (node, key) => Reflect.get(Object(node), key),
      implementer,
    );
    if (!(procedureImplementer instanceof ProcedureImplementer)) {
      throw new Error(`The implementer has no procedure at ${path.join(".")}`);
    }
    const procedure: AnyProcedure = new ContractProcedure(path.join("."), unarranged);
    procedures.push(procedure);
    return {
      hub: procedure,
      router: procedureImplementer.handler((options) => procedure.serve(options)),
    };
  }
  if (typeof contract !== "object" || contract === null) {
    throw new Error(`The contract has no procedure at ${path.join(".")}`);
  }
  const children = Object.entries(contract).map(
    ([key, child]) => [key, arrange(child, [...path, key], procedures, unarranged)] as const,
  );
  return {
    hub: Object.fromEntries(children.map(([key, { hub }]) => [key, hub])),
    router: Object.fromEntries(children.map(([key, { router }]) => [key, router])),
  };
}

/** Where Better Auth's client sends its calls, on the page's own origin. */
const AUTH_BASE = "/api/auth";

/** The words and code of each refusal the client knows, as Better Auth's routes send them. */
const AUTH_ERRORS = {
  ...BASE_ERROR_CODES,
  ...ORGANIZATION_ERROR_CODES,
} satisfies Record<AuthErrorCode, { code: string; message: string }>;

/**
 * The methods each of Better Auth's routes answers, by its path under `AUTH_BASE`, as its endpoints
 * declare them: its own, and its organization plugin's, the plugin whose routes the dashboard calls.
 * Read without a hub: the endpoints wait for the context only when called.
 */
const AUTH_METHODS = new Map<string, readonly string[]>(
  Object.values(getEndpoints(new Promise<never>(() => {}), { plugins: [organization()] }).api).map(
    (endpoint) => [endpoint.path, [endpoint.options.method].flat()],
  ),
);

/** One of Better Auth's routes, by its path under `AUTH_BASE`. */
class BetterAuthRoute extends Arrangement<unknown, unknown, APIError> {
  refuses(status: AuthStatus, code: AuthErrorCode) {
    this.answer = { kind: "refusal", refuse: APIError.from(status, AUTH_ERRORS[code]) };
  }
}

const AUTH_ROUTE_MEMBERS = new Set(["answers", "refuses", "fails", "drops", "hold", "calls"]);

/**
 * The route at the client's call `path`, whose address the client builds as its proxy does, each
 * name in kebab case, kept in `routes` by that address once a test reaches it.
 */
function authRoutes(
  routes: Map<string, BetterAuthRoute>,
  path?: string[],
): AuthRoutes<typeof authClient>;
// The client's calls are names on a proxy, which no type can follow; the overload above states what
// the proxy reaches, as the client's own types do for its proxy.
function authRoutes(routes: Map<string, BetterAuthRoute>, path: string[] = []): unknown {
  return new Proxy(
    {},
    {
      get(_, key) {
        if (typeof key !== "string") return undefined;
        if (!AUTH_ROUTE_MEMBERS.has(key)) return authRoutes(routes, [...path, key]);
        const address = `/${path.map(toKebabCase).join("/")}`;
        let route = routes.get(address);
        if (!route) {
          route = new BetterAuthRoute();
          routes.set(address, route);
        }
        const member: unknown = Reflect.get(route, key);
        return typeof member === "function" ? member.bind(route) : member;
      },
    },
  );
}

/** What a call to one of Better Auth's routes sends: its query for a read, else its JSON body. */
async function authInput(request: Request) {
  const url = new URL(request.url);
  if (request.method === "GET") return { query: Object.fromEntries(url.searchParams) };
  const body = await request.text();
  return body === "" ? undefined : JSON.parse(body);
}

/**
 * A stand-in for the hub that serves the dashboard at `origin`. Nothing is arranged: a call without
 * an answer fails, and is recorded in `network.unarranged`.
 */
export function createHub(origin: string): { hub: Hub; network: HubNetwork } {
  const session = new Arrangement<void, Session, never>();
  const auth = new Map<string, BetterAuthRoute>();
  const procedures: AnyProcedure[] = [];
  const unarranged: string[] = [];
  const { hub: api, router } = arrange(apiContract, [], procedures, unarranged);
  const apiHandler = createApiHandler(router);

  const hub: Hub = { ...api, session, auth: authRoutes(auth) };

  const sessionHandler = http.get(`${origin}${AUTH_BASE}/get-session`, async () => {
    const answer = await session.receive();
    switch (answer?.kind) {
      case "output":
        return HttpResponse.json(await answer.answer());
      case "loss":
        return HttpResponse.error();
      default:
        return HttpResponse.json(null, { status: 500 });
    }
  });

  const authHandler = http.all(`${origin}${AUTH_BASE}/*`, async ({ request }) => {
    const address = new URL(request.url).pathname.slice(AUTH_BASE.length);
    const route = auth.get(address);
    const input: unknown = await authInput(request);
    const methods = AUTH_METHODS.get(address);
    if (!methods?.includes(request.method)) {
      unarranged.push(
        `Better Auth's ${request.method} ${address}, a route that answers ${methods?.join(" or ") ?? "no method"}`,
      );
      return HttpResponse.json(null, { status: 404 });
    }
    if (!route?.answer) {
      unarranged.push(`Better Auth's ${request.method} ${address} with ${JSON.stringify(input)}`);
      return HttpResponse.json(null, { status: 500 });
    }
    const answer = await route.receive(input);
    switch (answer?.kind) {
      case "output":
        return HttpResponse.json((await answer.answer(input)) ?? null);
      case "refusal":
        return HttpResponse.json(answer.refuse.body, { status: answer.refuse.statusCode });
      case "loss":
        return HttpResponse.error();
      default:
        return HttpResponse.json(null, { status: 500 });
    }
  });

  // Every other request on the origin goes to the hub's handlers, whose router decides whether it is
  // a call of the API; one it does not route goes on to the build, or fails the test as a stray.
  const routerHandler = http.all(`${origin}/*`, async ({ request }) => {
    const exchange: Exchange = { lost: false };
    const { matched, response } = await apiHandler.handle(request, { context: { exchange } });
    if (!matched) return undefined;
    return exchange.lost ? HttpResponse.error() : response;
  });

  const network: HubNetwork = {
    handlers: [sessionHandler, authHandler, routerHandler],
    unarranged,
    releaseAll() {
      session.release();
      for (const route of auth.values()) route.release();
      for (const procedure of procedures) procedure.release();
    },
  };
  return { hub, network };
}
