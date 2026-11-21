/** The names used for each list and the IDs its filter controls and skip link target. */
export const listPages = {
  "/jobs": {
    title: "Jobs",
    singular: "job",
    plural: "jobs",
    end: "jobs-end",
    filters: "jobs-filters",
    /** What an empty list says to do, before the CLI's command. */
    empty: "Submit a Batch of jobs with the CLI: ",
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
