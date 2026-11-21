import { ByteSize } from "effect";

// Apart from format.ts, which every page loads, so that only the pages that write sizes load it.

/**
 * A size in bytes in the binary units the contract states its limits in, to one decimal place and
 * without a trailing zero: "614 B", "1.3 KiB", "146 KiB", "16 MiB", as the CLI writes sizes and the
 * contract's refusals write its limits.
 */
export function formatBytes(bytes: number): string {
  return ByteSize.format(ByteSize.bytes(bytes), { precision: 1 });
}
