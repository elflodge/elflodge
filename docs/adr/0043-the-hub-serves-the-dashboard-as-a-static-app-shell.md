# The hub serves the dashboard as a static app shell from its own origin

The web dashboard is a package of its own, `dashboard`: a SolidJS app built with TanStack Start in its SPA mode into a static app shell, `index.html`, and assets named by a hash of their content. It has no server of its own. The hub serves the build from its own origin, under `/dashboard/`, on both runtimes (ADR 0014): on Workers through Workers Static Assets, configured in `wrangler.jsonc`, which serve matching files before the Worker runs; in Docker through the Node hub's own routes, from the copy its build places beside it. Both hosts serve content-hashed assets with a year's caching, return 404 when a page requests a missing asset and serve the app shell for dashboard deep links. The app reads everything through the hub's API with the member's session cookie, which Better Auth sets only for sign-ins from the hub's own origin (ADR 0015), so sharing the origin also leaves the hub without CORS.

The dashboard has a base path because the API's paths sit at the root: a page at `/jobs/x` would collide with the API's route, and Workers Static Assets, which answer their base path before the Worker, would otherwise sit in front of every API request. `/` redirects to `/dashboard/` with 302, as people who open the hub's URL want the dashboard and a temporary redirect leaves room to change what `/` shows; the API reference moves from `/` to `/docs`, and the OpenAPI document stays at `/spec.json`, where clients read it.

With members' sessions in browsers, the hub refuses a member's request that a page on another site could make the browser send without asking: an unsafe request with a form's content type, or none, unless the browser says it comes from the hub's own origin, by `Sec-Fetch-Site` or by `Origin` matching `HUB_URL`. It uses Hono's CSRF middleware. A JSON request passes, as one from another site needs a CORS preflight, which the hub never answers; a permissive CORS policy would therefore open the hub to cross-site requests. A request carrying an API key is not checked: a browser never sends a key by itself, and callers with one, scripts and Runners, send no `Origin` and often no body. Nor is a request without cookies, which cannot act as a member and so gets the hub's own answer, such as a 401 naming how to authenticate; signing in, which needs no cookie, keeps Better Auth's own check of where it comes from.

## Considered options

- Rendering pages per request through Start's server build on Nitro: a second server build and packaging beside `vp pack` and Wrangler, and both hubs' entry points dispatching to its renderer, for an app behind sign-in whose pages show a member's own data and gain nothing from rendering on the server.
- The dashboard on an origin of its own, such as a static host: Better Auth would not sign members in from it, and its calls would need CORS with credentials and cross-site cookies.
- The dashboard inside the hub package, as a full-stack app with Cloudflare's Vite plugin, which ADR 0005 left open: the hub's two builds would carry a browser app's toolchain; as a package of its own, the dashboard builds apart and the hub serves only its output.
- The dashboard at the root and the API under a prefix: every released API path would move.
- CSRF tokens: they guard browsers that send neither fetch metadata nor `Origin`, and every browser the dashboard runs in sends `Origin` with an unsafe request.

## Consequences

The hub serves the dashboard's build, so the hub's build, development server and deploy build the dashboard first, as do its tests. For a missing asset, Workers Static Assets serve the shell when the request carries `Sec-Fetch-Mode: navigate`, so the asset rule and the Worker's 404 both send `Vary: Sec-Fetch-Mode` to keep caches from reusing one response for the other. Browsers send `Sec-Fetch-Mode` only to trustworthy origins, which includes a deployed Workers hub because it serves over HTTPS. Navigating to a missing asset's address returns 404 on Node. On Workers, Cloudflare serves that navigation without invoking the Worker, so the shell carries the asset path's cache header and the dashboard shows its not-found page.

## When to reconsider

When a page must show its content before the app loads, such as a public page read by search engines or link previews, or when the dashboard must be served from another origin than the hub's.
