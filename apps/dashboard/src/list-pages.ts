import { useRouter } from "@tanstack/solid-router";

import { focusIfLost } from "./form.ts";

/** The names used for each list and the IDs its filter controls and skip link target. */
export const listPages = {
  "/jobs": {
    title: "Jobs",
    singular: "job",
    plural: "jobs",
    end: "jobs-end",
    filters: "jobs-filters",
  },
  "/batches": {
    title: "Batches",
    singular: "Batch",
    plural: "Batches",
    end: "batches-end",
    filters: "batches-filters",
  },
} as const;

/** Restore lost focus after navigation has rendered the link's replacement. */
export function focusAfterLinkDrops(target: () => HTMLElement | null, onPress?: () => void) {
  const router = useRouter();
  return (event: MouseEvent & { currentTarget: HTMLAnchorElement }) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
      return;
    const link = event.currentTarget;
    const destination = link.href;
    onPress?.();
    const unsubscribe = router.subscribe("onResolved", () => {
      unsubscribe();
      if (!link.isConnected && location.href === destination) focusIfLost(target());
    });
  };
}
