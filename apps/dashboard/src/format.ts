/**
 * How the dashboard writes times and figures, with the platform's `Intl`. In British English, the
 * language of the page, so that a date reads "18 Nov 2026", a time "15:41" and a figure "12,279"
 * wherever the reader is, and the widths the pages are laid out for hold. An instant is written in
 * the reader's own time zone, which `Intl` takes from the browser.
 */
const LANGUAGE = "en-GB";

/** An instant's day and time, such as "18 Nov 2026, 15:41". */
export const DATE_TIME = new Intl.DateTimeFormat(LANGUAGE, {
  dateStyle: "medium",
  timeStyle: "short",
});

/** An instant's time alone, such as "15:41", where its day is said nearby. */
export const TIME = new Intl.DateTimeFormat(LANGUAGE, { timeStyle: "short" });

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

/** A count, such as of tokens or of jobs: "12,279". */
export function formatCount(count: number): string {
  return COUNT.format(count);
}

/** An amount in US dollars, such as "0.0031", without its unit, which the column head says. */
export function formatUsd(amount: number): string {
  return USD.format(amount);
}
