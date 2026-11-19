import { DATE_TIME, FULL, UTC_DATE } from "../format.ts";

/**
 * An instant, written in the reader's time zone by `format` (by default its day and time), in a
 * `time` element that carries it exactly, in UTC, for whatever reads the page. Its title gives it in
 * full, to the second and with the zone, for a reader who points at it.
 */
export function Instant(props: { value: Date; format?: Intl.DateTimeFormat }) {
  return (
    <time datetime={props.value.toISOString()} title={FULL.format(props.value)}>
      {(props.format ?? DATE_TIME).format(props.value)}
    </time>
  );
}

/** A calendar day the hub counts in UTC, given as `YYYY-MM-DD`, as the hub gives it. */
export function UtcDay(props: { value: string }) {
  // A date alone in ISO form is read as midnight UTC, which UTC_DATE writes as that day.
  return <time datetime={props.value}>{UTC_DATE.format(new Date(props.value))}</time>;
}
