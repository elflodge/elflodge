import { DATE_TIME, DATE_TIME_SECONDS, FULL, TIME_SECONDS, elapsedSince } from "../format.ts";

/**
 * An instant, written in the reader's time zone by `format` (by default its day and time), in a
 * `time` element that carries it exactly, in UTC, for whatever reads the page. Its title gives it in
 * full, to the second and with the zone, for a reader who points at it. It is empty without a
 * value, which happens only while a `Show` that tests an optional field takes it away.
 */
export function Instant(props: { value: Date | undefined; format?: Intl.DateTimeFormat }) {
  return (
    <time datetime={props.value?.toISOString()} title={props.value && FULL.format(props.value)}>
      {props.value && (props.format ?? DATE_TIME).format(props.value)}
    </time>
  );
}

/** A Runner’s contact, relative to the read and dated when it was on an earlier local day. */
export function LastContact(props: { at: Date | undefined; readAt: number }) {
  return (
    <>
      {props.at && elapsedSince(props.at, props.readAt)},{" "}
      {props.at?.toDateString() === new Date(props.readAt).toDateString() ? (
        <>
          at <Instant value={props.at} format={TIME_SECONDS} />
        </>
      ) : (
        <Instant value={props.at} format={DATE_TIME_SECONDS} />
      )}
    </>
  );
}
