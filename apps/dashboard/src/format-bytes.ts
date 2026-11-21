import { filesize } from "filesize";

import { LANGUAGE } from "./format.ts";

// Apart from format.ts, which every page loads, so that only the pages that write sizes load filesize.

/**
 * A size in bytes in the binary units the contract states its limits in, to one decimal place:
 * "614 B", "1.3 KiB", "18.2 MiB". A size that is a whole number of its unit, as the contract's limits
 * are, is written whole, "16 MiB", as the contract's refusals write it.
 */
export function formatBytes(bytes: number): string {
  return filesize(bytes, {
    base: 2,
    standard: "iec",
    round: 1,
    pad: bytes % 1024 ** Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1024)) !== 0,
    locale: LANGUAGE,
  });
}
