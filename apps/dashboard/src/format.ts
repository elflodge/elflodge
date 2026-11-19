/**
 * How the dashboard writes times and figures, with the platform's `Intl`. The pages are in English;
 * British English writes a date day first, "18 Nov 2026", and a time on the 24-hour clock, "15:41",
 * which no reader takes for another day or hour, and a figure as "12,279". It is fixed rather than
 * taken from the browser, so the widths the pages are laid out for hold for every reader. An instant
 * is written in the reader's own time zone, which `Intl` takes from the browser.
 */
const LANGUAGE = "en-GB";

/** An instant's day and time, such as "18 Nov 2026, 15:41". */
export const DATE_TIME = new Intl.DateTimeFormat(LANGUAGE, {
  dateStyle: "medium",
  timeStyle: "short",
});

/** An instant's time alone, such as "15:41", where its day is said nearby. */
export const TIME = new Intl.DateTimeFormat(LANGUAGE, { timeStyle: "short" });

/** An instant's time and the reader's time zone, such as "15:41 CET", where the zone is not said nearby. */
export const TIME_ZONED = new Intl.DateTimeFormat(LANGUAGE, {
  hour: "2-digit",
  minute: "2-digit",
  timeZoneName: "short",
});

/** The note a page shows once beside its instants, valid on both sides of a clock change. */
export function timeZoneNote(): string {
  const format = new Intl.DateTimeFormat(LANGUAGE, { timeZoneName: "longGeneric" });
  const zone = format.formatToParts().find((part) => part.type === "timeZoneName");
  return `Times are shown in ${zone?.value ?? format.resolvedOptions().timeZone}.`;
}

/** An instant in full, to the second and with its time zone: "Wednesday, 18 November 2026 at 15:41:22 CET". */
export const FULL = new Intl.DateTimeFormat(LANGUAGE, { dateStyle: "full", timeStyle: "long" });

/**
 * A calendar day the hub counts in UTC, such as a day of usage: "18 Nov 2026". Written in UTC, so
 * that it is the hub's day wherever the reader is.
 */
export const UTC_DATE = new Intl.DateTimeFormat(LANGUAGE, { dateStyle: "medium", timeZone: "UTC" });

const COUNT = new Intl.NumberFormat(LANGUAGE);

// Four decimals: a job's cost is often a fraction of a cent, which two would show as 0.00.
const USD = new Intl.NumberFormat(LANGUAGE, {
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});

const PLURAL = new Intl.PluralRules(LANGUAGE);

/** `one` or `other`, the word that goes with `count`, such as "1 agent" and "2 agents". */
export function plural(count: number, one: string, other: string): string {
  return PLURAL.select(count) === "one" ? one : other;
}

/** A count, such as of tokens or of jobs: "12,279". */
export function formatCount(count: number): string {
  return COUNT.format(count);
}

/** An amount in US dollars, such as "0.0031", without its unit, which the column head says. */
export function formatUsd(amount: number): string {
  return USD.format(amount);
}
