// Scalar's exports omit package.json. Reading it by path lets the bundler inline the version.
import scalar from "../node_modules/@scalar/api-reference/package.json" with { type: "json" };

/**
 * Where the hub serves the dashboard. The dashboard sets it as its Vite `base`
 * (`apps/dashboard/vite.config.ts`), and `wrangler.jsonc` and the dashboard's `public/_headers` repeat
 * it for the Workers hub.
 */
export const DASHBOARD_BASE = "/dashboard/";
/** Vite's asset directory under the base path, also named in the dashboard's public/_headers. */
export const DASHBOARD_ASSETS = "assets";

// The dashboard copies the published bundle unchanged. The exact installed version identifies the
// bytes at this URL for as long as browsers cache them.
export const SCALAR_DIRECTORY = `${DASHBOARD_ASSETS}/scalar-${scalar.version}`;

/** The URL of the dashboard's `page` on the hub at `hubUrl`, such as `setup`. */
export function dashboardUrl(hubUrl: string, page: string) {
  return new URL(DASHBOARD_BASE + page, hubUrl);
}
