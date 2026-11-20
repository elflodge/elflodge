import {
  JOB_CANCELLED,
  JOB_FAILED,
  JOB_PAUSED,
  JOB_RECOVERED,
  JOB_RESUMED,
  JOB_STARTED,
  JOB_SUCCEEDED,
  type finalJobStatusSchema,
} from "contract";

type FinalStatus = (typeof finalJobStatusSchema.options)[number];

export interface JobLifecycle {
  label: string;
  runHeading?: string;
  since?: string;
  finalStatus?: FinalStatus;
}

export const JOB_LIFECYCLE: ReadonlyMap<string, JobLifecycle> = new Map<string, JobLifecycle>([
  [JOB_STARTED, { label: "Started", runHeading: "Run started", since: "Running since" }],
  [JOB_RESUMED, { label: "Resumed", runHeading: "Run resumed", since: "Resumed" }],
  [JOB_RECOVERED, { label: "Recovered" }],
  [JOB_PAUSED, { label: "Paused" }],
  [JOB_FAILED, { label: "Failed", finalStatus: "failed" }],
  [JOB_CANCELLED, { label: "Cancelled", finalStatus: "cancelled" }],
  [JOB_SUCCEEDED, { label: "Succeeded", finalStatus: "succeeded" }],
]);
