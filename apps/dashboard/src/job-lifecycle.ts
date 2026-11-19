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
type RunPhrase = (ended: Date, resumed: Date, elapsed: string) => (string | Date)[];

export interface JobLifecycle {
  label: string;
  runHeading?: string;
  since?: string;
  finalStatus?: FinalStatus;
  gap?: RunPhrase;
  after?: RunPhrase;
}

function ending(label: string, finalStatus: FinalStatus, after?: RunPhrase): JobLifecycle {
  return {
    label,
    finalStatus,
    gap: (ended, resumed) => [`${label} `, ended, "; resumed ", resumed],
    after,
  };
}

// Keep instants in the sentence as dates so every view renders the same accessible time element.
export const JOB_LIFECYCLE: ReadonlyMap<string, JobLifecycle> = new Map<string, JobLifecycle>([
  [JOB_STARTED, { label: "Started", runHeading: "Run started", since: "Running since" }],
  [JOB_RESUMED, { label: "Resumed", runHeading: "Run resumed", since: "Resumed" }],
  [JOB_RECOVERED, { label: "Recovered" }],
  [
    JOB_PAUSED,
    {
      label: "Paused",
      gap: (ended, resumed, elapsed) => [`Paused for ${elapsed}, `, ended, " to ", resumed],
      after: (_ended, _resumed, elapsed) => [`, after a pause of ${elapsed}`],
    },
  ],
  [JOB_FAILED, ending("Failed", "failed", (ended) => [", after it failed at ", ended])],
  [
    JOB_CANCELLED,
    ending("Cancelled", "cancelled", (ended) => [", after it was cancelled at ", ended]),
  ],
  [JOB_SUCCEEDED, ending("Succeeded", "succeeded")],
]);
