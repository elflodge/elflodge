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

/** The reader’s calendar day, also the YYYY-MM-DD form HTML time elements take. */
export const LOCAL_ISO_DATE = new Intl.DateTimeFormat("sv-SE", { dateStyle: "short" });

/** A local creation day in the year of the read. */
export const DAY = new Intl.DateTimeFormat(LANGUAGE, { day: "numeric", month: "short" });
/** A local creation day outside the year of the read. */
export const DAY_YEAR = new Intl.DateTimeFormat(LANGUAGE, { dateStyle: "medium" });
/** A Usage day, such as “19 Nov”, dated by the hub in UTC. */
export const UTC_DAY = new Intl.DateTimeFormat(LANGUAGE, {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
});
/** A UTC day with its year, for a report outside the year of the read. */
export const UTC_DAY_YEAR = new Intl.DateTimeFormat(LANGUAGE, {
  timeZone: "UTC",
  dateStyle: "medium",
});
/** The short weekday of a Usage day in UTC. */
export const UTC_WEEKDAY = new Intl.DateTimeFormat(LANGUAGE, { timeZone: "UTC", weekday: "short" });
/** The name and year of a calendar month in Range. */
export const UTC_MONTH = new Intl.DateTimeFormat(LANGUAGE, {
  timeZone: "UTC",
  month: "long",
  year: "numeric",
});
export const TIME = new Intl.DateTimeFormat(LANGUAGE, { timeStyle: "short" });
/** An event time, dated when it falls outside the row group’s creation day. */
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

/** The failed and last successful reads each give the second and the reader’s zone. */
export const TIME_SECONDS_ZONED = new Intl.DateTimeFormat(LANGUAGE, {
  ...zonedTime,
  second: "2-digit",
});

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

// Four decimal places keep costs comparable. Rounding smaller costs by significant digits keeps them visible.
// roundingPriority shipped in Chromium 106, Firefox 116 and Safari 15.4, within our browser floor.
// https://github.com/mdn/browser-compat-data/blob/main/javascript/builtins/Intl/NumberFormat.json
const usdPrecision = {
  maximumFractionDigits: 4,
  maximumSignificantDigits: 2,
  roundingPriority: "morePrecision",
} satisfies Intl.NumberFormatOptions;
const USD = new Intl.NumberFormat(LANGUAGE, { ...usdPrecision, minimumFractionDigits: 4 });

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

/** Round a USD cost to four decimal places or at most two significant digits, whichever is more precise. */
export function formatUsd(amount: number): string {
  return USD.format(amount);
}

/** Budgets use the same precision as costs, with a minimum of two decimal places. */
export const USD_BUDGET = new Intl.NumberFormat(LANGUAGE, {
  ...usdPrecision,
  minimumFractionDigits: 2,
});

/** A member choosing a new budget must exceed the exact cost the hub reports. */
export const USD_THRESHOLD = new Intl.NumberFormat(LANGUAGE, { maximumSignificantDigits: 21 });

// Intl.DurationFormat first shipped in Firefox 136. The dashboard supports Firefox 125.
// https://github.com/mdn/browser-compat-data/blob/main/javascript/builtins/Intl/DurationFormat.json
const HOURS = new Intl.NumberFormat(LANGUAGE, { style: "unit", unit: "hour" });
const MINUTES = new Intl.NumberFormat(LANGUAGE, { style: "unit", unit: "minute" });
const SECONDS = new Intl.NumberFormat(LANGUAGE, { style: "unit", unit: "second" });
const UNITS = new Intl.ListFormat(LANGUAGE, { type: "unit", style: "narrow" });

/** A length in whole seconds, including the seconds left after whole hours and minutes. */
export function duration(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60) % 60;
  const parts = [];
  if (hours) parts.push(HOURS.format(hours));
  if (minutes) parts.push(MINUTES.format(minutes));
  if (whole % 60 || !parts.length) parts.push(SECONDS.format(whole % 60));
  return UNITS.format(parts);
}
