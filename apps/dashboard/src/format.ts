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

/** Creation days and event times in a Jobs list, where the day line supplies the date. */
export const DAY = new Intl.DateTimeFormat(LANGUAGE, { day: "numeric", month: "short" });
export const DAY_YEAR = new Intl.DateTimeFormat(LANGUAGE, { dateStyle: "medium" });
export const TIME = new Intl.DateTimeFormat(LANGUAGE, { timeStyle: "short" });
export const DAY_TIME = new Intl.DateTimeFormat(LANGUAGE, {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/** Second-precision instants where the page already names the reader's zone. */
export const TIME_SECONDS = new Intl.DateTimeFormat(LANGUAGE, { timeStyle: "medium" });
export const DATE_TIME_SECONDS = new Intl.DateTimeFormat(LANGUAGE, {
  dateStyle: "medium",
  timeStyle: "medium",
});

const RELATIVE = new Intl.RelativeTimeFormat(LANGUAGE, { style: "short" });

/** Elapsed at the read that reported it. Different clocks can put contact just ahead of the read. */
export function elapsedSince(contact: Date, readAt: number): string {
  const seconds = Math.max(0, Math.floor((readAt - contact.getTime()) / 1000));
  if (seconds < 60) return RELATIVE.format(-seconds, "second");
  if (seconds < 3600) return RELATIVE.format(-Math.floor(seconds / 60), "minute");
  if (seconds < 86400) return RELATIVE.format(-Math.floor(seconds / 3600), "hour");
  return RELATIVE.format(-Math.floor(seconds / 86400), "day");
}

const zonedTime = {
  hour: "2-digit",
  minute: "2-digit",
  timeZoneName: "short",
} satisfies Intl.DateTimeFormatOptions;

/** An instant's time and the reader's time zone, such as "15:41 CET", where the zone is not said nearby. */
export const TIME_ZONED = new Intl.DateTimeFormat(LANGUAGE, zonedTime);

/** An invitation can expire on another day, so its lone instant includes the date as well. */
export const DATE_TIME_ZONED = new Intl.DateTimeFormat(LANGUAGE, {
  ...zonedTime,
  day: "numeric",
  month: "short",
});

function zoneName(timeZoneName: "longGeneric" | "short"): string {
  const { timeZone } = DATE_TIME.resolvedOptions();
  const format = new Intl.DateTimeFormat(LANGUAGE, { timeZone, timeZoneName });
  const zone = format.formatToParts().find((part) => part.type === "timeZoneName");
  return zone?.value ?? timeZone;
}

/** Name the zone once above a list. Intl can give an offset even for UTC, whose short name is UTC. */
export function timeZoneNote(): string {
  const generic = zoneName("longGeneric");
  return `Times are in ${generic.startsWith("GMT") ? zoneName("short") : generic}.`;
}

/** An instant in full, to the second and with its time zone: "Wednesday, 18 November 2026 at 15:41:22 CET". */
export const FULL = new Intl.DateTimeFormat(LANGUAGE, { dateStyle: "full", timeStyle: "long" });

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

const ROLE_LIST = new Intl.ListFormat(LANGUAGE, { type: "conjunction" });

/** Better Auth stores a membership's roles as comma-separated names. */
export function formatRoles(roles: string): string {
  return ROLE_LIST.format(roles.split(","));
}

/** An amount in US dollars, such as "0.0031", without its unit, which the column head says. */
export function formatUsd(amount: number): string {
  return USD.format(amount);
}

export const USD_BUDGET = new Intl.NumberFormat(LANGUAGE, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
