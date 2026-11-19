import { chromium } from "playwright";

/** The hub accepts sign-in only from its own origin. Resolve that host to the local test hub. */
export function launchDashboardBrowser(
  system: { origin: string; url(): URL },
  publicOrigin?: string,
) {
  const origins = publicOrigin ? [system.origin, publicOrigin] : [system.origin];
  const rules = origins.map((origin) => `MAP ${new URL(origin).hostname} ${system.url().host}`);
  const args = [`--host-resolver-rules=${rules.join(",")}`];
  // Give the reference's public-looking HTTP origin the secure context of a deployed HTTPS hub.
  if (publicOrigin) args.push(`--unsafely-treat-insecure-origin-as-secure=${publicOrigin}`);
  return chromium.launch({ args });
}
