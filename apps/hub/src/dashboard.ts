/**
 * Where the hub serves the dashboard. The dashboard sets it as its Vite `base`
 * (`apps/dashboard/vite.config.ts`), and `wrangler.jsonc` and the dashboard's `public/_headers` repeat
 * it for the Workers hub.
 */
export const DASHBOARD_BASE = "/dashboard/";
/** Vite's asset directory under the base path, also named in the dashboard's public/_headers. */
export const DASHBOARD_ASSETS = "assets";

/** The URL of the dashboard's `page` on the hub at `hubUrl`, such as `setup`. */
export function dashboardUrl(hubUrl: string, page: string) {
  return new URL(DASHBOARD_BASE + page, hubUrl);
}
