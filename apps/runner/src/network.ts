import { BlockList, isIP } from "node:net";
import { networkInterfaces } from "node:os";

import type { SandboxAskCallback, SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
// How sandbox-runtime itself reads a destination before matching and dialing it. It is not on the
// package's main entry, which has no `exports` map to stop this import; should a release move it,
// the build fails rather than the callback reading hosts differently.
import { canonicalizeHost } from "@anthropic-ai/sandbox-runtime/dist/sandbox/parent-proxy.js";
import { containsCidr, excludeCidr, mergeCidr } from "cidr-tools";
import { Data, Effect } from "effect";

// The network a job's commands have (ADR 0041): the public internet through sandbox-runtime's
// proxies, which refuse local and private destinations unless the operator opened their range, or
// nothing at all. sandbox-runtime enforces it; this module only turns the Runner's settings into its
// configuration, and into what the agent is told.

/** The network a Runner can give jobs, as `RUNNER_NETWORK` names it. */
export const NETWORK_MODES = ["open", "none"] as const;

export type NetworkMode = (typeof NETWORK_MODES)[number];

/** What the Runner's operator chose for jobs' network. */
export interface NetworkSettings {
  /** `open`: the public internet, local and private addresses refused; `none`: no network. */
  readonly mode: NetworkMode;
  /** Ranges opened despite the refusal. */
  readonly exceptions: readonly NetworkException[];
}

/** An address range opened despite the refusal, on one port or on all. */
export interface NetworkException {
  /** As `mergeCidr` writes it (`10.0.0.0/8`, `fd00::1/128`). */
  readonly range: string;
  /** The one port opened; every port when absent. */
  readonly port?: number;
}

export const DEFAULT_NETWORK_SETTINGS: NetworkSettings = { mode: "open", exceptions: [] };

/** The setting that opens ranges, named in refusals so that the operator knows what to change. */
const EXCEPTIONS_SETTING = "RUNNER_NETWORK_EXCEPTIONS";

/** An entry of `RUNNER_NETWORK_EXCEPTIONS` that cannot be opened, and why. */
export class InvalidException extends Data.TaggedError("InvalidException")<{
  readonly message: string;
}> {}

/**
 * Reads an exception written as sandbox-runtime writes a destination, a port optional (`10.0.0.5`,
 * `10.0.0.0/8:8080`, `[fd00::5]:8080`; an IPv6 range takes its port in brackets), into what
 * `NetworkSettings` keeps, or fails saying what is wrong with it. Every address (`/0`) is refused:
 * it would open everything, the default's refusals included, and pi-web-access refuses it. So is an
 * IPv4-mapped IPv6 range: sandbox-runtime judges such a destination by its IPv4 address, which the
 * exception would not subtract from the refused IPv4 ranges.
 */
export function parseException(entry: string): Effect.Effect<NetworkException, InvalidException> {
  return Effect.gen(function* () {
    const bracketed = /^\[([^\]]*)\](?::(.*))?$/.exec(entry);
    const withPort = /^([^:[\]]*):([^:]*)$/.exec(entry);
    const [address = entry, port] = bracketed?.slice(1) ?? withPort?.slice(1) ?? [];
    const notARange = new InvalidException({
      message: `${JSON.stringify(entry)} is not an IP address or CIDR range`,
    });
    // cidr-tools' error says no more than `notARange`.
    const range = yield* Effect.try({ try: () => mergeCidr([address])[0], catch: () => notARange });
    if (range === undefined) return yield* notARange;
    if (range.endsWith("/0"))
      return yield* new InvalidException({ message: `${range} opens every address` });
    if (range.includes(":") && containsCidr("::ffff:0:0/96", range))
      return yield* new InvalidException({
        message: `${entry} is an IPv4-mapped address: write the IPv4 address or range`,
      });
    if (port === undefined) return { range };
    // sandbox-runtime's own reading of a port.
    if (!/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535)
      return yield* new InvalidException({
        message: `${JSON.stringify(entry)} has no port from 1 to 65535 after its address`,
      });
    return { range, port: Number(port) };
  });
}

/** An exception as sandbox-runtime and the agent read a destination, as `parseException` reads it. */
export function formatException({ range, port }: NetworkException): string {
  if (port === undefined) return range;
  return range.includes(":") ? `[${range}]:${port}` : `${range}:${port}`;
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
  /** What a refusal calls the class's addresses, the subject of "are blocked". */
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
  { name: "Broadcast addresses", ranges: ["255.255.255.255/32"] },
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
 * initialize it with. Open, it refuses `host`'s addresses and the default classes, the addresses
 * less the exception ranges, and asks the callback about every other destination, which refuses
 * `localhost`.
 * sandbox-runtime checks the deny list before the allow list, and its resolved-address guard holds
 * names to the same lists, so each exception is allowed too, on its port if it names one: the
 * guard's own loopback, link-local and host-address refusals give way only to an allowed range. An
 * exception so opens exactly what it covers, the host's addresses included, as sandbox-runtime
 * itself would. Every entry is a range, single addresses included, as an entry without `/` is
 * compared as text.
 *
 * The deny list cannot except a port, so an exception's range leaves it whole, and the other ports
 * of a range opened on one port are refused separately: an address literal by the callback, which
 * allows everything else; a name by the guard, which refuses resolving into the range unless the
 * allow list opens the address and port.
 */
export function sandboxNetwork(
  settings: NetworkSettings,
  host: readonly string[],
): {
  network: SandboxRuntimeConfig["network"];
  askCallback?: SandboxAskCallback;
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
  const opening = ` The Runner's operator can open a range with ${EXCEPTIONS_SETTING}.`;
  const reasons = new Map<string, string>();
  const opened = settings.exceptions.map(({ range }) => range);
  const refused: string[] = [];
  const deny = (entries: readonly string[], reason: string) => {
    refused.push(...entries);
    for (const entry of excludeCidr(entries, opened))
      if (!reasons.has(entry)) reasons.set(entry, reason);
  };
  deny(host, `Addresses of the Runner's own host are blocked for jobs.${opening}`);
  for (const { name, ranges, reachable = [] } of REFUSED_CLASSES) {
    deny(excludeCidr(ranges, reachable), `${name} are blocked for jobs.${opening}`);
  }
  const onOnePort = settings.exceptions.flatMap(({ range, port }) =>
    port === undefined ? [] : [range],
  );
  // Only the refused part of them: an exception on a port of a public address closes no other.
  const portLimited = excludeCidr(onOnePort, excludeCidr(onOnePort, refused));
  const limited = new BlockList();
  for (const range of portLimited) {
    const [address = "", prefix] = range.split("/");
    limited.addSubnet(address, Number(prefix), isIP(address) === 6 ? "ipv6" : "ipv4");
  }
  const otherPort = {
    allow: false as const,
    reason: `This address is open to jobs only on the ports that ${EXCEPTIONS_SETTING} names for it.`,
  };
  const localhost = {
    allow: false as const,
    reason:
      "localhost through the proxy is the Runner's host, which jobs cannot reach. A server this job started is reached at localhost without the proxy.",
  };
  return {
    network: {
      allowedDomains: settings.exceptions.map(formatException),
      deniedDomains: [...reasons.keys()],
      deniedDomainReasons: Object.fromEntries(reasons),
      ...(portLimited.length === 0 ? {} : { deniedResolvedAddresses: portLimited }),
    },
    // sandbox-runtime matches its lists on the host as it dials it, but asks the callback with the
    // host as the job wrote it, where `[::ffff:10.0.0.5]` and `167772165` are also 10.0.0.5.
    askCallback: async (destination) => {
      const dialed = canonicalizeHost(destination.host) ?? destination.host;
      // `localhost` and names under it, however many trailing dots they carry, here rather than in
      // the deny list: that matches with one dot removed, and the resolved-address guard, removing
      // another, lets such a name resolve to any loopback address the deny list leaves out, other
      // ports of one opened on a port included.
      if (/(?:^|\.)localhost\.*$/i.test(dialed)) return localhost;
      const family = isIP(dialed);
      // `BlockList` matches an IPv4-mapped address against IPv4 ranges.
      return family !== 0 && limited.check(dialed, family === 6 ? "ipv6" : "ipv4")
        ? otherPort
        : true;
    },
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
    : `Local and private network addresses are blocked, except ${settings.exceptions.map(formatException).join(", ")}.`;
}
