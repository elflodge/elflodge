import { expect, inject } from "vite-plus/test";

import { setUpOrganization } from "../src/setup.ts";
import { clearDatabase } from "./harness.ts";

// A hub without an Organization and the setup link it prints, for the tests of setting one up.

export const NEW_OWNER = { email: "new-owner@example.com", password: "a long enough password" };
/** What the setup form sends, apart from the token. */
export const SETUP = { organizationName: "Harbor & Pine", name: "Robin Hale", ...NEW_OWNER };

/** Empties the hub's database and sets it up as a hub without owner settings does: its link. */
export async function setupLink(system: { origin: string }) {
  await clearDatabase(inject("databaseUrl"));
  return newSetupLink(system);
}

/** Sets the hub up again without owner settings, which prints a new link. */
export async function newSetupLink(system: { origin: string }) {
  const messages: string[] = [];
  await setUpOrganization(
    inject("databaseUrl"),
    { owner: {}, hubUrl: system.origin, canPrintSetupLink: true },
    (message) => messages.push(message),
  );
  const link = new URL(messages.join("\n").split("\n").at(-1) ?? "");
  expect(link.origin + link.pathname).toBe(`${system.origin}/dashboard/setup`);
  return { link, token: link.hash.slice(1) };
}
