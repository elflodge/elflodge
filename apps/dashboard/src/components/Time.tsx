import { DATE_TIME, FULL } from "../format.ts";

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
