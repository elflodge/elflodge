import dashboard from "../../dashboard/package.json" with { type: "json" };

/**
 * Where the hub serves the dashboard. The dashboard sets it as its Vite `base`
 * (`apps/dashboard/vite.config.ts`), and `wrangler.jsonc` and the dashboard's `public/_headers` repeat
 * it for the Workers hub.
 */
export const DASHBOARD_BASE = "/dashboard/";
export const DASHBOARD_ASSETS = "assets";

// The dashboard copies the published bundle unchanged. Its exact package version identifies the
// bytes at this URL for as long as browsers cache them.
export const SCALAR_ASSETS = `${DASHBOARD_ASSETS}/scalar-${dashboard.devDependencies["@scalar/api-reference"]}`;

/** The URL of the dashboard's `page` on the hub at `hubUrl`, such as `setup`. */
export function dashboardUrl(hubUrl: string, page: string) {
  return new URL(DASHBOARD_BASE + page, hubUrl);
}
