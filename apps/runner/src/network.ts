import { BlockList, isIP } from "node:net";
import { networkInterfaces } from "node:os";

import type { SandboxAskCallback, SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
// sandbox-runtime's own reading of a destination's port, of an address range into a BlockList, and
// of the IPv4 address an IPv6 address carries, from the same unexported modules, so that exceptions
// and destinations are read and matched as it reads its lists.
import {
  addRange,
  addressInSet,
  embeddedIPv4,
  isLoopbackName,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/address.js";
import { splitDomainPatternPort } from "@anthropic-ai/sandbox-runtime/dist/sandbox/domain-pattern.js";
// How sandbox-runtime itself reads a destination before matching and dialing it, an IPv4-mapped
// address as its IPv4 address. It is not on the package's main entry, which has no `exports` map to
// stop this import; should a release move it, the typecheck and the Runner's start fail rather than
// the callback reading hosts differently, as the Runner's build leaves dependencies external.
import { canonicalizeHost } from "@anthropic-ai/sandbox-runtime/dist/sandbox/parent-proxy.js";
import { containsCidr, excludeCidr, mergeCidr } from "cidr-tools";
import { Data, Effect } from "effect";

// The network a job's commands have (ADR 0041): the public internet through sandbox-runtime's
// proxies, which refuse local and private destinations unless the operator opened their range, or
// nothing at all. sandbox-runtime enforces it; this module turns the Runner's settings into its
// configuration and the ask callback that judges IP destinations, and into what the agent is told.

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
 * IPv4-mapped IPv6 range: sandbox-runtime and the Runner judge such a destination by its IPv4
 * address, which the exception's range would not cover.
 */
export function parseException(entry: string): Effect.Effect<NetworkException, InvalidException> {
  return Effect.gen(function* () {
    // A port that is not one, such as `:0`, is left on the address, which then fails as a range.
    const { hostPattern: address, port } = splitDomainPatternPort(entry);
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
    return port === undefined ? { range } : { range, port };
  });
}

/** An exception as sandbox-runtime and the agent read a destination, as `parseException` reads it. */
export function formatException({ range, port }: NetworkException): string {
  if (port === undefined) return range;
  return range.includes(":") ? `[${range}]:${port}` : `${range}:${port}`;
}

/**
 * The destinations refused by default, each class with the reason a refusal gives. They are the
 * rows of IANA's IPv4 and IPv6 Special-Purpose Address Registries whose "Globally Reachable" is
 * False, with the rows inside them that are True or N/A left open, plus multicast, which is in
 * neither registry, and cloud metadata. Not `::ffff:0:0/96` (IPv4-mapped): a `BlockList` reads that
 * range as every IPv4 address, and an IPv4-mapped destination is judged by its IPv4 address anyway.
 * The first class listing a destination gives its reason, so the narrower classes come first.
 * A copy, as sandbox-runtime's guard takes refused addresses only as ranges and no package exports
 * these registries as ranges: ipaddr.js classifies one address at a time, and @sdxc/ip's
 * `SPECIAL_PURPOSE_RANGES` is not exported (sergiodxa/monorepo#83).
 */
const REFUSED_CLASSES: readonly {
  /** What a refusal calls the class's addresses, the subject of "are blocked". */
  readonly name: string;
  readonly ranges: readonly string[];
  /** Rows inside `ranges` that the registry marks globally reachable, or N/A. */
  readonly reachable?: readonly string[];
}[] = [
  // Azure's WireServer, in public address space. The other cloud metadata endpoints are in ranges
  // refused below, and sandbox-runtime's resolved-address guard refuses names resolving to any.
  { name: "Cloud metadata addresses", ranges: ["168.63.129.16/32"] },
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
 * initialize it with. Open, every destination reaches the callback, which judges an IP address
 * itself, however it is spelled, and leaves a name to sandbox-runtime's resolved-address guard,
 * which judges where the name resolves.
 *
 * The guard refuses `deniedResolvedAddresses` (here the default classes, less the ranges opened on
 * every port) and its own classes: loopback, link-local, cloud metadata
 * and `host`'s addresses. An address and port in `allowedDomains` overrides both, but that list
 * takes single addresses only (ranges need anthropics/sandbox-runtime#807), so it holds each
 * exception that is one, and `host`'s addresses in each range opened, with the exception's port.
 * A name so reaches a range opened on one port only at those addresses, and the guard's own classes
 * in an opened range likewise: such names are refused, never let through.
 *
 * Off, everything is refused before the callback, with one reason.
 */
export function sandboxNetwork(
  settings: NetworkSettings,
  host: readonly string[],
): {
  network: SandboxRuntimeConfig["network"];
  askCallback?: SandboxAskCallback;
} {
  if (settings.mode === "none") {
    const reason = "This Runner gives jobs' commands no network access (RUNNER_NETWORK=none).";
    return {
      network: { allowedDomains: [], deniedDomains: ["*"], deniedDomainReasons: { "*": reason } },
    };
  }
  const opening = ` The Runner's operator can open a range with ${EXCEPTIONS_SETTING}.`;
  const refusedRanges = REFUSED_CLASSES.map(({ name, ranges, reachable = [] }) => ({
    name,
    ranges: excludeCidr(ranges, reachable),
  }));
  const classes = [
    { name: "Addresses of the Runner's own host", ranges: host },
    ...refusedRanges,
  ].map(({ name, ranges }) => ({
    ranges,
    addresses: blockList(ranges),
    refusal: { allow: false as const, reason: `${name} are blocked for jobs.${opening}` },
  }));
  const exceptions = settings.exceptions.map((exception) => ({
    ...exception,
    addresses: blockList([exception.range]),
  }));
  const allowed = settings.exceptions.flatMap(({ range, port }) =>
    (isSingleAddress(range) ? [range] : host.filter((address) => containsCidr(range, address))).map(
      (address) => formatAllowed(address, port),
    ),
  );
  const onEveryPort = settings.exceptions.flatMap(({ range, port }) =>
    port === undefined ? [range] : [],
  );
  const unreadable = {
    allow: false as const,
    reason: "This destination is not a host name or IP address that the Runner can check.",
  };
  const localhost = {
    allow: false as const,
    reason:
      "localhost through the proxy is the Runner's host, which jobs cannot reach. A server this job started is reached at localhost without the proxy.",
  };
  const otherPort = {
    allow: false as const,
    reason: `This address is open to jobs only on the ports that ${EXCEPTIONS_SETTING} names for it.`,
  };
  return {
    network: {
      allowedDomains: [...new Set(allowed)],
      deniedDomains: [],
      // Not `host`'s addresses: the guard refuses those itself, as they are now rather than as the
      // Runner started, and says so.
      deniedResolvedAddresses: excludeCidr(
        refusedRanges.flatMap(({ ranges }) => ranges),
        onEveryPort,
      ),
    },
    // sandbox-runtime asks with the host as the job wrote it, where `[::ffff:10.0.0.5]` and
    // `167772165` are also 10.0.0.5, so the callback reads it as sandbox-runtime does before it
    // dials. What that cannot read is refused rather than judged as written.
    askCallback: async (destination) => {
      const dialed = canonicalizeHost(destination.host);
      if (dialed === undefined) return unreadable;
      // `localhost` and names under it, however many trailing dots they carry: the guard, removing
      // one, lets such a name resolve to any loopback address. `isLoopbackName` removes one dot, so
      // all go first.
      if (isLoopbackName(dialed.replace(/\.+$/, ""))) return localhost;
      // A name: the guard judges where it resolves.
      if (isIP(dialed) === 0) return true;
      // An IPv6 address that carries an IPv4 one, such as NAT64's `64:ff9b::a00:5`, is delivered to
      // it, so it is refused as that address is too, as the guard refuses names. Only the address
      // itself is matched against exceptions, as in the guard, so an exception opens no such form.
      const carried = embeddedIPv4(dialed);
      const refused = classes.find(
        ({ addresses }) =>
          addressInSet(addresses, dialed) ||
          (carried !== undefined && addressInSet(addresses, carried)),
      );
      if (refused === undefined) return true;
      const covering = exceptions.filter(({ addresses }) => addressInSet(addresses, dialed));
      if (covering.length === 0) return refused.refusal;
      return covering.some(({ port }) => port === undefined || port === destination.port)
        ? true
        : otherPort;
    },
  };
}

function blockList(ranges: readonly string[]): BlockList {
  const list = new BlockList();
  for (const range of ranges) addRange(list, range);
  return list;
}

function isSingleAddress(range: string): boolean {
  return range.endsWith(range.includes(":") ? "/128" : "/32");
}

/** A single-address range as sandbox-runtime's allow list takes an address: bare, IPv6 bracketed. */
function formatAllowed(range: string, port: number | undefined): string {
  const address = range.slice(0, range.indexOf("/"));
  const host = address.includes(":") ? `[${address}]` : address;
  return port === undefined ? host : `${host}:${port}`;
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
