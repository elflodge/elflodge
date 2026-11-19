import { chromium } from "playwright";

/** The hub accepts sign-in only from its own origin. Resolve that host to the local test hub. */
export function launchDashboardBrowser(system: { origin: string; url(): URL }) {
  return chromium.launch({
    args: [`--host-resolver-rules=MAP ${new URL(system.origin).hostname} ${system.url().host}`],
  });
}
