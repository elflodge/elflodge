import { Effect, identity } from "effect";

import { sweepUnusedBlobs } from "./blobs.ts";
import { sweepInvitations } from "./invitations.ts";

/** Removes unused Blob data and closed or expired invitations every hour. Each cleanup gets its
 * turn even when the other fails, and the scheduler receives the failures after both finish.
 */
export const sweepUnusedBlobsAndInvitations = Effect.validate(
  [sweepUnusedBlobs, Effect.asVoid(sweepInvitations)],
  identity,
  { discard: true },
);
