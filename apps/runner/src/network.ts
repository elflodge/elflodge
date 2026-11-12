import { networkInterfaces } from "node:os";

import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { containsCidr, excludeCidr, mergeCidr } from "cidr-tools";

// The network a job's commands have (ADR 0041): the public internet through sandbox-runtime's
// proxies, which refuse local and private destinations unless the operator opened their range, or
// nothing at all. sandbox-runtime enforces it; this module only turns the Runner's settings into its
// configuration, and into what the agent is told.

/** What the Runner's operator chose for jobs' network. */
export interface NetworkSettings {
  /** `open`: the public internet, local and private addresses refused; `none`: no network. */
  readonly mode: "open" | "none";
  /** Ranges opened despite the refusal, as `mergeCidr` writes them (`10.0.0.0/8`, `fd00::1/128`). */
  readonly exceptions: readonly string[];
}

export const DEFAULT_NETWORK_SETTINGS: NetworkSettings = { mode: "open", exceptions: [] };

/** The setting that opens ranges, named in refusals so that the operator knows what to change. */
const EXCEPTIONS_SETTING = "RUNNER_NETWORK_EXCEPTIONS";

/**
 * Checks and writes an exception as `NetworkSettings` keeps it, or says what is wrong with it.
 * Every address (`/0`) is refused: it would open the host's loopback to jobs, and pi-web-access
 * refuses it. So is an IPv4-mapped IPv6 range: sandbox-runtime judges such a destination by its
 * IPv4 address, which the exception would not subtract from the refused IPv4 ranges.
 */
export function parseException(entry: string): { range: string } | { problem: string } {
  let range: string | undefined;
  try {
    range = mergeCidr([entry])[0];
  } catch {
    // Its error says no more than the problem below.
  }
  if (range === undefined)
    return { problem: `${JSON.stringify(entry)} is not an IP address or CIDR range` };
  if (range.endsWith("/0")) return { problem: `${range} opens every address` };
  if (range.includes(":") && containsCidr("::ffff:0:0/96", range))
    return { problem: `${entry} is an IPv4-mapped address: write the IPv4 address or range` };
  return { range };
}

/**
 * Cloud instance-metadata and platform endpoints, as sandbox-runtime's resolved-address guard
 * lists them (`CLOUD_METADATA_ADDRESSES` in 0.0.82, not exported). The guard holds them only
 * against names; listed here, they are refused as literal destinations too, Azure's
 * `168.63.129.16` above all, which is in public address space.
 */
const CLOUD_METADATA = [
  "100.100.100.200/32",
  "168.63.129.16/32",
  "192.0.0.192/32",
  "fd00:ec2::/32",
  "fd20:ce::254/128",
  "fd00:c1::a9fe:a9fe/128",
  "fd00:42::42/128",
  "fd00:a9fe:a9fe::1/128",
  "fd00:100::100:200/128",
];

/**
 * The destinations refused by default, each class with the reason a refusal gives. They are the
 * rows of IANA's IPv4 and IPv6 Special-Purpose Address Registries whose "Globally Reachable" is
 * False, with the rows inside them that are True or N/A left open, plus multicast, which is in
 * neither registry, and cloud metadata. Not `::ffff:0:0/96` (IPv4-mapped): sandbox-runtime reads that
 * entry as every IPv4 address, and judges an IPv4-mapped destination by its IPv4 address anyway.
 * The first class listing a destination gives its reason, so the narrower classes come first.
 */
const REFUSED_CLASSES: readonly {
  readonly name: string;
  readonly ranges: readonly string[];
  /** Rows inside `ranges` that the registry marks globally reachable, or N/A. */
  readonly reachable?: readonly string[];
}[] = [
  { name: "Cloud metadata addresses", ranges: CLOUD_METADATA },
  { name: "Loopback addresses", ranges: ["127.0.0.0/8", "::1/128"] },
  { name: "Unspecified addresses", ranges: ["0.0.0.0/8", "::/128"] },
  { name: "Link-local addresses", ranges: ["169.254.0.0/16", "fe80::/10"] },
  {
    name: "Private network addresses",
    ranges: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"],
  },
  { name: "Shared (carrier-grade NAT) addresses", ranges: ["100.64.0.0/10"] },
  { name: "Multicast addresses", ranges: ["224.0.0.0/4", "ff00::/8"] },
  { name: "The broadcast address", ranges: ["255.255.255.255/32"] },
  {
    name: "Documentation addresses",
    ranges: ["192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24", "2001:db8::/32", "3fff::/20"],
  },
  { name: "Benchmarking addresses", ranges: ["198.18.0.0/15", "2001:2::/48"] },
  {
    name: "Reserved special-purpose addresses",
    ranges: [
      "192.0.0.0/24",
      "192.88.99.2/32",
      "240.0.0.0/4",
      "64:ff9b:1::/48",
      "100::/64",
      "100:0:0:1::/64",
      "2001::/23",
      "5f00::/16",
    ],
    reachable: [
      "192.0.0.9/32",
      "192.0.0.10/32",
      "2001::/32",
      "2001:1::1/128",
      "2001:1::2/128",
      "2001:1::3/128",
      "2001:3::/32",
      "2001:4:112::/48",
      "2001:20::/28",
      "2001:30::/28",
    ],
  },
];

/** The unicast addresses on this host's network interfaces now, each as a single-address range. */
export function hostAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .flatMap((address) => (address ? mergeCidr([address.address]) : []));
}

/**
 * sandbox-runtime's process-wide network configuration for `settings`, and the ask callback to
 * initialize it with. Open, it refuses the default classes less the exception ranges, then
 * `localhost` and `host`'s addresses, which no exception opens, and asks the callback, which allows,
 * about every other destination. sandbox-runtime checks the deny list before the allow list, and
 * its resolved-address guard holds names to the same lists, so each exception range is allowed too:
 * the guard's own loopback, link-local and host-address refusals give way only to an allowed range.
 * Every entry is a range, single addresses included, as an entry without `/` is compared as text.
 */
export function sandboxNetwork(
  settings: NetworkSettings,
  host: readonly string[],
): {
  network: SandboxRuntimeConfig["network"];
  askCallback?: () => Promise<boolean>;
} {
  if (settings.mode === "none") {
    return {
      network: {
        allowedDomains: [],
        deniedDomains: [],
        allowlistDenyReason:
          "This Runner gives jobs' commands no network access (RUNNER_NETWORK=none).",
      },
    };
  }
  const reasons = new Map<string, string>([
    [
      "localhost",
      "localhost through the proxy is the Runner's host, which jobs cannot reach. A server this job started is reached at localhost without the proxy.",
    ],
  ]);
  const deny = (entries: readonly string[], reason: string) => {
    for (const entry of entries) if (!reasons.has(entry)) reasons.set(entry, reason);
  };
  deny(
    host,
    "Addresses of the Runner's own host are blocked for jobs, whatever the Runner's settings.",
  );
  for (const { name, ranges, reachable = [] } of REFUSED_CLASSES) {
    deny(
      excludeCidr(excludeCidr(ranges, reachable), settings.exceptions),
      `${name} are blocked for jobs; the Runner's operator can open a range with ${EXCEPTIONS_SETTING}.`,
    );
  }
  return {
    network: {
      allowedDomains: [...settings.exceptions],
      deniedDomains: [...reasons.keys()],
      deniedDomainReasons: Object.fromEntries(reasons),
    },
    askCallback: async () => true,
  };
}

/**
 * The sentence the agent is told about its commands' network, made from the settings that make the
 * policy, so the two cannot disagree; the same for every job of a Runner.
 */
export function describeNetwork(settings: NetworkSettings): string {
  if (settings.mode === "none") return "Commands have no network access.";
  return settings.exceptions.length === 0
    ? "Local and private network addresses are blocked."
    : `Local and private network addresses are blocked, except ${settings.exceptions.join(", ")}.`;
}
