import { Effect, identity } from "effect";

import { sweepUnusedBlobs } from "./blobs.ts";
import { sweepInvitations } from "./invitations.ts";

/** Removes unused Blob data and expired invitations, reporting failures after both sweeps. */
export const sweepUnusedBlobsAndInvitations = Effect.validate(
  [sweepUnusedBlobs, sweepInvitations],
  identity,
  { discard: true },
);
