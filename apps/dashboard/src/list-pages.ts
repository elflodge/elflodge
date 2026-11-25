/** The names used for each list and the IDs its filter controls and skip link target. */
export const listPages = {
  "/jobs": {
    title: "Jobs",
    singular: "job",
    plural: "jobs",
    end: "jobs-end",
    filters: "jobs-filters",
    empty: "Choose Submit a job to run your first job.",
  },
  "/batches": {
    title: "Batches",
    singular: "Batch",
    plural: "Batches",
    end: "batches-end",
    filters: "batches-filters",
    empty: "A Batch runs one agent on many jobs. Submit one with Submit a Batch, or with the CLI: ",
  },
} as const;
