# The dashboard takes widget behaviour from UI SDK

Some of the dashboard's controls need behaviour no plain element gives. A confirmation that removes a Runner or revokes a key sends a request and waits for the hub: while it waits, its confirming button must take no second press and keep the focus, the wait must be announced, and the member must not lose the answer. Afterwards focus must land somewhere useful, also when the row whose button opened the dialog is gone. Written by hand over the native `dialog`, each confirmation kept its own pending and failure state, restored focus that disabling a button had lost, waited for a later read to drop the row before moving focus, and, because Escape could close the dialog while its request ran, needed a second place on the page to report a refusal that arrived after.

That behaviour comes from Vercel's UI SDK, `@ui-sdk/solid` on its framework-free core `@ui-sdk/core`, published for Solid 2. Its parts own the running action, dismissal, focus on opening and closing, the inert page and the announcements, with the ARIA each needs, and render no styles: the dashboard's own stylesheets style them through their `data-slot` attributes, and `app.css` declares UI SDK's cascade layer first so that the little CSS it adds gives way to ours. The dashboard keeps what is its own: the words, the requests, the rules of the product such as "already gone" after a 404, its notices and when it reads again.

A confirmation on a list is one alert dialog for the list, `ConfirmDialog`, outside it, opened by a trigger part in each row that carries the record as the dialog's payload. An async action on its confirming Close part runs the request: a rejection keeps the dialog open with the reason in the part's state, and a resolution closes it with focus on the page's notice of the outcome. While it runs, Escape and the keeping button are refused, so a member never leaves a confirmation whose answer has nowhere to show.

Since the member cannot leave a running confirmation, a request the hub never answers must end by itself. Every call the dashboard makes to the hub ends after 30 seconds, through oRPC's `TimeoutLinkPlugin` for the API and better-fetch's `timeout` for Better Auth's client, except an upload, which takes as long as its file needs. A write that got no answer may have reached the hub, so its failure says it may have been done anyway.

UI SDK is a 0.1 beta, so its version is pinned exactly and each upgrade reads its changes.

## Considered options

- Behaviour written by hand over native elements, as before: `dialog` has no state for a running action, so every dialog carried its own, with its own focus repairs, and a refusal after a dismissal had nowhere to show but the page.
- Ark UI 6 on Zag 2: its dialog models only open and closed, leaving the running action to each caller as before, and its Solid 2 build was not published.
- UI SDK's shared `confirm()`: it takes strings and answers a boolean, so it cannot hold the request, a heading with markup, or a failure line.
- A dialog in each row: it goes with its row when a read drops the record, and a refusal still to come shows nowhere.
- A deadline passed by each confirmation for its own request: Query gives a mutation function no signal, and a form or a control waits on the hub as a confirmation does.

## Consequences

The first page that uses UI SDK loads about 30 KiB more of gzipped JavaScript, in a chunk only the pages that use it load; later parts share its core. UI SDK adds a `style` element and inline styles, so a Content Security Policy needs its nonce. A member waits at most 30 seconds for an unanswered write before the confirmation can be left. A read is tried again by Query, so an unanswered read reports its failure only after its tries, and a confirmation that waits for one, as after a 404 to learn whether the record is gone, can hold the member for about two minutes. Dialogs still written on the native element keep their own behaviour.

## When to reconsider

When UI SDK stops publishing for the Solid release the dashboard runs on, or a pinned upgrade keeps breaking its parts' behaviour. When a part the dashboard needs is missing and its core cannot build it. When the dashboard needs a deadline that differs by call.
