## Agent skills

### Issue tracker

Issues live in GitHub Issues for `elflodge/elflodge`, used through the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The project's triage labels are documented in `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Conventions

- The product is Elflodge in prose, one word with a capital E, and `elflodge` wherever it is typed: the package, the command, URLs.
- Two Node floors. What users run on their own Node, the CLI, the Runner, their shared contract and the extension adapter, supports Node 22 from 22.19: it uses only what Node 22 has (`lib: es2024`), and CI tests it on Node 22. The hub runs only on runtimes we choose, Node 26 and workerd, and may use anything they implement.
- After `vp add`, check `package.json`: with `catalogMode: prefer`, it turns `workspace:*` dependencies into `catalog:` entries; set them back to `workspace:*`.
- After changing a migration, run `vp run hub#db:types`; after upgrading Better Auth, run `vp run hub#db:draft-auth-migration`. CI fails on either otherwise.
- A comment that records a decision stays until the decision is re-opened; changing the behaviour means re-opening the decision, not deleting the comment.
- A name says what the code does, effects included; an abstract name is justified only where the difference it hides is one no caller cares about. A read-sounding name must not hide a write. Abstracting over how (a join behind `listRunners`) is fine; abstracting over what happens is not.
- Before writing code by hand or adding a library, check whether Effect, or an Effect platform package already in use, does it; for arrays and objects, use Effect's call where it reads better than plain JavaScript.
- A value becomes a branded ID once, where it enters: through the type's constructor (`Brand.nominal`), or, for a library's brand without one, such as pi-durable's IDs, a type guard that checks the value. Never an assertion or a lint suppression.
- Keep a caught `Error` intact, including its cause. Use `ensure-error` before logging or inspecting a value that still needs conversion to an `Error`.
- A Node emitter the code holds, such as a socket, a pool, a server or a child process, gets an `error` listener when it is acquired and keeps it until it is destroyed: an unhandled `error` event ends the process, outside any fiber or promise.
- Prefer optional over `null` unless there is a domain reason, such as the database's explicit `NULL` against no update. Never remap external data to swap `null` and `undefined`; keep the source's shape.

## Schema

- Before writing the queries that use a schema change, show the maintainer its tables, columns and constraints, one table per message, and wait for approval.
- Until a migration is released, it is edited in place; no fix-up migration follows it.
- On Workers the previous release can still write to the new schema after setup. Make its writes fail wherever they would record incorrect data, or explain in a comment at the migration what the previous release would record and why that is acceptable.
- Every foreign key states, in the migration, what deleting the parent means for the row. Where the row must outlive the parent, the parent's ID is copied and not referenced, as a job's Runner and `keyCreatorUserId` are; `kanel.config.cjs` keeps such a column typed as the parent's ID. A column that copies IDs from several tables stays unbranded, as `submitterId` holds an API key's ID or a user's ID.
- Every nullable column states, in the migration, why it can be null. A counter or flag is not null with a database default.
- A column carrying a protocol field uses the field's name. A column nothing reads yet holds only a fact that could not be recorded later, such as who submitted a job.
- A CHECK or unique constraint reflects a rule the data must hold; do not add one to make the schema look rigorous.
- Instants are `timestamptz`, written as `Date`, never as strings. Where a table's columns record different clocks, such as the hub's and a Runner's, a comment says which clock each column records.
- Kysely write semantics: `undefined` omits the column, `null` writes SQL `NULL`, any other value is written. Do not use `value ?? null` unless omission deliberately means clearing the column.
- Inserts and updates are typed with the generated `New<Table>` and `<Table>Update` types, Kanel's `Insertable` and `Updateable` of the table; `<Table>Update` is already partial.

## Queries

- Prefer typed Kysely expressions over SQL text wherever Kysely can represent the query: CASE via `eb.case()`, arithmetic via `eb(lhs, op, rhs)`, window functions via `eb.fn.agg().over()`, `eb.fn.coalesce`, `eb.val` for a parameter and `eb.lit` only for an inline number, boolean or null, `eb.cast` for a SQL cast, `eb.fn("name", [...])` for any other function. Nested results are built in SQL: each relation through one correlated `jsonArrayFrom` or `jsonObjectFrom`, or, for many parents, children aggregated per parent in a CTE and joined; never several one-to-many relations joined and grouped together.
- Rows from the caller enter a statement as one JSON parameter expanded with `jsonb_array_elements`, each scalar field read with `->>` and cast and each JSON value with `->`; not as a union of one select per row.
- A `WITH` clause with `UNION ALL`: build each branch separately, pass `a.unionAll(b)` to `with()`, and keep the branches' column types identical.
- Do data work in SQL, not in code that stitches round trips together or queries per row (on the Workers hub each round trip crosses Hyperdrive); split statements where the work splits naturally.
- Cast a bound value in a call PostgreSQL cannot infer its type from, such as `jsonBuildObject` or another function taking any type: `eb.cast(eb.val(reason), "text")`. A TypeScript type argument or `$castTo` emits no SQL cast.
- `executeTakeFirst()` adds no `LIMIT 1`; add `.limit(1)` to a non-unique lookup.
- Filter a parent by its children with `EXISTS`, not a join and `GROUP BY`. In a grouped query every selected non-aggregate column is grouped or aggregated: Kysely type-checks what Postgres rejects.
- An empty child collection is `[]`, never an object of nulls.
- pg reads scalar `date` and `timestamptz` results as JavaScript `Date` objects. A scalar `date` is midnight in the process's local time zone. Inside JSON, dates and timestamps are strings, with a `date` in `YYYY-MM-DD` form. Kanel types `int8` and `numeric` as `number`. For a scalar `int8`, including `COUNT` and `SUM` of integers, the hub's pool returns a JavaScript number within the safe integer range and fails the query outside it. For a scalar `numeric`, including `AVG` and `SUM` of an `int8`, it returns the nearest number. Inside JSON, such as `jsonArrayFrom`, pg's `JSON.parse` reads `int8` and `numeric` as the nearest number. Add up money in SQL, where `numeric` is exact, and cast a `SUM` of an `int8` back to `int8` to keep it exact.

## API

- Read a record in one statement and include the facts the hub derives about it in its own answer, so callers can report them from one snapshot.
- The contract defines the caller-visible input, output and errors; handlers stay thin and the logic lives in the hub's modules.
- Each procedure declares in the contract who may make it (`byKey`, `byMember` or `byKeyOrMember`, with the key's permissions, or `byAnyone` for calls anyone can start, including setup and invitation preview or acceptance); the hub checks it before every call and never runs one that declares none. A call a member may make is built on `forMembers`, which declares the 403 a signed-in account that is not a member gets.
- A route's method and full path are declared on the procedure and verified at runtime and in the generated OpenAPI document; contract nesting does not build the path.
- An output schema's nullability follows its source: a not-null column passed through is non-null, a nullable one is `.nullable()`, a computed field that may be absent is `.optional()`; a `T | null | undefined` from a module is normalised before the contract.
- A stored enum in the API matches the database enum; a value SQL widened to `string` is parsed with the schema, not asserted.

## Dashboard

- Pages follow `apps/dashboard/DESIGN.md`: semantic HTML with its tokens, plain elements and named parts. A page that needs a new part adds it, and its description there, in the same change; when two pages built side by side share parts, a change before both may bring them.
- Behaviour a plain element does not give, such as a dialog that waits for the hub, its focus and its announcements, comes from UI SDK (`@ui-sdk/solid`), styled by the dashboard's own stylesheets, rather than written by hand. Before using it, read `apps/dashboard/node_modules/@ui-sdk/solid/docs/llms.txt`, then the pages of the components used. What a UI SDK part's interaction reads from a query, or makes Solid recompute, goes through `latest`: a trigger's payload and label taken from a row, the conditions that show the triggers, what the dialog renders and what the confirmed action recomputes. Read a whole list or record as `createMemo(() => latest(() => deep(query.data)))`; reading just the fields needed inside `latest` serves as well. While a query that already has data reads again under the same key, by a poll, an invalidation or a refresh on return to the tab, Solid Query makes `data` a pending value. Solid stages plain writes until the end of a flush, and a flush that reruns a derivation of that pending value joins the transaction waiting for it, so every write staged in that flush waits for the read, the part's state included, wherever the derivation sits among the components or in the DOM: on Runners, rows reading the list directly held a confirmation's opening until the poll answered. A reader the interaction does not touch, such as the hub strip's counts, reads `data` directly. A query whose key changes keeps its own loading state, since through `latest` it would show the old record's data beside the new id.
- The hub data a page displays is held by TanStack Query (`src/query.ts`), in one `QueryClient` for the document: loaders reach it in the router's context as `context.queryClient`, and components with `useQueryClient()`. Once a document has shown a member, a session read naming another user ID or no one reloads the document. `orpc` gives every call's key and options.
- A page reads with `useQuery(() => orpc.batches.get.queryOptions({ input: { id } }))`. A loader for displayed data warms the cache and returns nothing: `await context.queryClient.query(orpc.batches.get.queryOptions({ input: { id }, staleTime: "static" }))`, which reads only what is not held yet, at any age, as the deprecated `ensureQueryData` did; the page's `useQuery` reads again in the background what is older than the default `staleTime`. A loader whose read fails shows the page that failed. Setup and sign-in read setup status directly to decide where to redirect. The signed-in shell reads the Better Auth session in `beforeLoad`. Its route context carries `user` and `membership` to child routes. The shell displays them from its loader data, and `_member` reads membership from the same loader, because the router drops route context while a route is pending (TanStack/router#8115). Move both readers back to route context when a Solid Start release builds with that fix (TanStack/router#8964). The membership whose status is `member` includes the Organization and role. Preloaded route data is immediately stale in the router (`defaultPreloadStaleTime: 0`), so Query decides when to refresh page data. Query also reads again what is shown and stale when the page becomes visible and when the browser reconnects, and does not retry a call the hub refused: an answer with a 4xx status, or an `ORPCError` with no Problem Details, which oRPC raises itself, such as for an answer the contract does not allow. A 5xx answer, or a call that got none, is tried again.
- Jobs and Batches share `ListFilters`, `ListEnd` and `EmptyList`. Each list supplies its fields, search schema and exact query key so Apply can refresh the first page in place. Forms are native until TanStack Form has a released Solid 2 adapter (TanStack/form#2464), because its released adapters do not load on Solid 2; `createFormAction` is the default way to submit one. Submit buttons in `createFormAction` forms use `aria-disabled` while pending to keep focus. Record control buttons use `disabled` while their request is pending.
- A write that changes data a query shows goes through `useMutation(() => orpc.batches.cancel.mutationOptions({ onSuccess }))`, or a `mutationFn` for Better Auth's client, even where the page reads nothing from the hook: the client then keeps the write's state, where any component can read it and where it can outlive the component that started it. The caller awaits `mutate` and catches a refusal there. Each `mutate` is a Solid action, and a plain signal written beside a call shows only when every overlapping call on that hook has settled, whichever caller's await ends first; a `createOptimistic` write shows at once. So a plain write at the press, such as a pending flag or clearing an earlier failure, goes in `onFlush`, and a row's own state lives in its own signal or a UI SDK part's state, as a confirmation's does, since a list's rows share one hook. A UI SDK part writes its pending state in the tick its action starts, so an action that calls `mutate` first awaits `new Promise<void>((resolve) => onFlush(resolve))`. A record's controls read their pending state from `isPending`. `onSuccess` cancels older reads of the record with `await queryClient.cancelQueries({ queryKey, exact: true })` using its `orpc` key, and writes the hub's answer with `queryClient.setQueryData(queryKey, record)`; for a job, it also cancels the job's Events follower and any history read that can reach the newest end. After `mutate`, close the dialog and move focus, then invalidate the affected list keys, and `orpc.jobs.counts.key()` when the control changes a count in the hub strip, without awaiting them; a notice written in the same frame as a reread is held with it, so `flush()` it first. A `ConfirmDialog`'s `act` writes and flushes its notice and starts the rereads before UI SDK closes the dialog and moves focus, once `act` resolves; nothing the dialog or its rows read waits for those rereads. Calls stay direct where the hook and the mutation cache would keep a password or a new API key from their input or answer (sign-in, setup, a password change, accepting an invitation, creating a key), and for sign-out, which replaces the document.
- Key a `Show` or `Match` whose child reads a value that can go away while shown, or whose `Match` can lose its selection while its value stays set, unless a rebuild when the value changes would drop focus, a title or a live region that should survive the change; then read the source directly, guarding for its absence. In Solid 2.0.0 to 2.0.3 a non-keyed accessor can return `undefined` or throw "Stale read" while its branch is going away, because its value vanished or an earlier `Match` took over, and the removal waits on an asynchronous read; a throw halts the page's updates. A keyed child is rebuilt when its value's identity changes, which for a primitive means its value. On list pages that read `query.data` directly, Solid Query's store keeps an object's identity across polls even when its fields change; the job and Batch pages, the Runners and API keys lists, and the hub's limits on Submit a job and Submit a Batch read a `latest(() => deep(read.data))` snapshot, where an unchanged object keeps its identity but any changed field, a `Date` included, gives it a new one. Drop the rule when a Solid release returns the narrowed value.

## Tests

- Add a test only for behaviour a caller depends on. A fix or a new edge case is not by itself a reason for one; a comment can record why code behaves as it does.
- Assert through the interface under test. Read the database only for a persistence invariant that no public interface exposes.
- Set up state through typed APIs where one exists, and through SQL only when none does or the scenario needs internal state.
- Choose failure and recovery cases by likelihood and impact; no elaborate tests for speculative edges.

## Review

Questions for a change touching the database or the API, beside the general review:

- Do nullable and optional fields mean distinct, intentional states?
- Do writes preserve `undefined` against `null`?
- Is money added up in SQL rather than in JavaScript?
- Do insert and conflict-update omissions preserve defaults and stored values?
- Does a non-unique `executeTakeFirst()` need `.limit(1)`?
- Does nested aggregation preserve the parent's cardinality and empty arrays?
- Does every grouped query account for each selected column?
- Does each contract field exist on the handler's return value with the promised nullability and enum shape?

<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Running Scripts

Run TypeScript and JavaScript files with `vpx <file>`, for example `vpx ./scripts/seed.ts --dry-run`. It handles enums, decorators, JSX, and tsconfig `paths`, so do not add `tsx` or `ts-node` to run scripts. `vpx --watch <file>` reruns the file when a file it uses changes, in place of `tsx watch`. `vp node <file>` runs plain Node.js.

## Tool Versions

Run `vp toolchain` to show versions and relationships in the active Vite+
release. Add a tool name to select part of the graph. For example, run
`vp toolchain vite`. Use `--global` to ignore the local `vite-plus` package. Use
`vp why <package>` to show the package-manager dependency graph.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->
