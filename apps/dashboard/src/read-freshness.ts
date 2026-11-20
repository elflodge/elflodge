import { focusManager, onlineManager } from "@tanstack/solid-query";
import { createMemo, from } from "solid-js";

// The smallest round cutoff beyond the poll and retries (5 + 1 + 2 + 4 seconds) lets a fast outage
// go straight from figures to failure. An unmeasured starting value; revisit with either policy.
const MAX_ANSWER_AGE = 15_000;

export function browserOnline() {
  return createMemo(() =>
    from<boolean>((next) => {
      next(onlineManager.isOnline());
      return onlineManager.subscribe(next);
    }),
  );
}

export function readIsFresh(updatedAt: () => number) {
  return createMemo(() => {
    const answeredAt = updatedAt();
    const expiresAt = answeredAt + MAX_ANSWER_AGE;
    if (!answeredAt || Date.now() >= expiresAt) return false;
    // Wake once at expiry and recheck on visibility changes because hidden tabs throttle timers.
    return from<boolean>((next) => {
      const check = () => next(Date.now() < expiresAt);
      check();
      const timer = setTimeout(() => next(false), Math.max(0, expiresAt - Date.now()));
      const unsubscribe = focusManager.subscribe(check);
      return () => {
        clearTimeout(timer);
        unsubscribe();
      };
    });
  });
}
