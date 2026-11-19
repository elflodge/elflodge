import ensureError from "ensure-error";

import { migrateDatabase } from "../src/db/migrate.ts";
import { setUpOrganization } from "../src/setup.ts";

// FIXME: operators get the CLI, not this repository (ADR 0004), so this command moves into the
// CLI once it exists.
// Prepares the hub's database at `DATABASE_URL`: applies migrations, then, unless the Organization
// exists, creates it and its owner from `ADMIN_EMAIL` and `ADMIN_PASSWORD`, or prints a setup link to
// the hub at `HUB_URL` when run in a terminal. A hub on Workers has no start-up of its own, so this
// runs as a deploy step; the Docker hub does the same as it starts.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("Set DATABASE_URL to the hub's database");
  process.exit(1);
}
try {
  await migrateDatabase(databaseUrl);
  await setUpOrganization(databaseUrl, {
    owner: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD },
    hubUrl: process.env.HUB_URL,
    // Most CI jobs capture stdout without a terminal. Some allocate one and log it too, so CI
    // deploys set the owner's credentials. Whoever reads the setup link first can claim the hub.
    canPrintSetupLink: process.stdout.isTTY,
  });
} catch (error) {
  console.error(ensureError(error).message);
  process.exit(1);
}
