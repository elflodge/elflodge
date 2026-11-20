# Hono and oRPC, contract-first, on the newest major versions

The job API is an oRPC contract in a shared `contract` package, with schemas in Zod Mini; the Runner protocol's socket schemas live there too, but the socket carries JSON-RPC, not oRPC (ADR 0026). The hub implements them; the TypeScript client and the dashboard consume them with full types and no code generation, and the HTTP API is served as REST through oRPC's OpenAPI handler, which also produces an OpenAPI document for other languages. Hono hosts the API, the runner connection route and, later, Better Auth.

The package exports two contracts. `apiContract` is the public API, for people and their programs: the CLI, the OpenAPI document and the TypeScript client derive from it, under the public API's compatibility. `runnerHttpContract` holds the two HTTP calls only a Runner makes, registering and downloading its jobs' Input files; they belong to the Runner protocol and its version (ADR 0026), so the public tools leave them out. The hub implements both, composed into one router; every procedure declares its own path, so the composition changes no route. Which tool sees which call is decided by which contract holds it, not inferred from a call's permissions.

To implement ADR 0010, the TypeScript client link and the OpenAPI document share a JSON Schema converter that leaves contract-defined response objects open. An unfamiliar member still lets the client match a Job by its status and convert its dates before validation. `apps/hub/tests/openapi.test.ts` checks every response schema in the document and reads Job, ListedJob, Batch and Events answers with added members through the link.

A typed map still constrains each value. For example, a new Label must have a string value. Removing or retyping a known member, or adding a value to a closed enum, can also break a client. A union that chooses a branch by which members are present needs a discriminator before its members are extended. For example, adding a valid `batchId` to a Runner usage group makes the Batch branch match first, and the client drops `runner`.

We start on the newest major line of each dependency even before it is stable, pinning exact versions while pre-release: oRPC 2 changed its wire format, so clients on version 1 could not talk to a version 2 hub, and starting on the line going forward avoids a coordinated migration later.

On public reads, `Job.blockedBy`, `Job.statusUnknown.reason` and `failure.reason` explain what happened. A newer hub can give a reason an older client has no words for. The client shows the hub's word and marks it as unknown to that version. An unfamiliar failure reason still describes a fault. The contract's `openEnum` helper pairs the known enum with a string branded on input and output. Producers can type-check the values they send, and readers can distinguish the known vocabulary before looking up its words. The OpenAPI document follows the extensible enum recipe in [OAI/OpenAPI-Specification#1552](https://github.com/OAI/OpenAPI-Specification/issues/1552#issuecomment-382640465). It uses `anyOf` with the known enum and a string. A known value matches both branches, so `oneOf` would reject it. Runner reports use the known failure reasons the hub can store.

Job and Batch statuses, controls and `Submitter.kind` stay closed because callers use them to decide what they may do.

Reconsider this representation if OpenAPI standardizes an extensible enum with generator support, or if a caller needs to decide what action is safe from one of these reasons.

## Considered options

- The `x-extensible-enum` vendor extension depends on each generator recognizing it. Standard JSON Schema keywords describe both branches to any validator.
- A plain `string` accepts new reasons but omits the known vocabulary from the document and gives producers no check on its spelling.
- Closing these enums and dropping their promise of new values would let an additional explanation hide an otherwise readable job during an upgrade.
- Making the existing schema names open would silently widen the Runner protocol and the vocabulary used for counts and word maps. Explicit open schemas put that choice at public reads.

- One contract, each tool filtering out the Runner's calls: oRPC's `generate(router, { filter })` reaches only the OpenAPI document, OpenAPI tags and an `x-internal` extension only label operations for tools that read them, trpc-cli has no option to leave a procedure out, and the TypeScript client would still carry the calls. The CLI filtered by the permissions a call needs, which a future person's key holding a `runner` permission would break.
- Hono alone, with its validators and typed client: the client is tied to the server's route types, and OpenAPI needs another package.
- Elysia: its Cloudflare Workers adapter is experimental, OpenAPI type generation does not work there, and its client is typed from the server instead of a separate contract.
- Classic Zod: about 80 KB more in the Worker bundle; Zod Mini shares the Zod core that Better Auth already brings and converts to JSON Schema natively.
