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
