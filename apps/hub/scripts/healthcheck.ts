import { lookup } from "node:dns";
import { get } from "node:http";
import { BlockList, type LookupFunction, setDefaultAutoSelectFamily } from "node:net";
import { networkInterfaces } from "node:os";

// The image copies this script alone, so it uses only Node's builtins.

// Docker keeps the probe's output in the container's health log.
function fail(reason: unknown) {
  console.error(reason);
  process.exitCode = 1;
}

const host = process.env.HOST;
const port = process.env.PORT ?? 8787;
// Without HOST the hub listens on every interface.
const target = host || "::";
// Node binds `::` to IPv4 too, so a wildcard bind, given as an address or a name for one, is probed
// on IPv4 loopback, which a container keeps without IPv6.
const wildcards = new Set(["0.0.0.0", "::"]);

// This container's addresses. The kernel answers all of 127.0.0.0/8 locally, though interfaces
// list only 127.0.0.1.
const own = new BlockList();
own.addSubnet("127.0.0.0", 8, "ipv4");
for (const { address, family } of Object.values(networkInterfaces()).flatMap(
  (list) => list ?? [],
)) {
  own.addAddress(address, family === "IPv6" ? "ipv6" : "ipv4");
}

// Resolves as dns.lookup does, keeping only this container's addresses, so a container sharing the
// name never answers for this one. Node's connect turns `hints: 0` into a filter that hides IPv6 on
// a network without it, though the listener may have bound ::1 for localhost, so it is set here.
const findOwnAddresses: LookupFunction = (_hostname, options, callback) =>
  lookup(target, { ...options, hints: 0, all: true }, (error, addresses) => {
    if (error) return callback(error, []);
    const mine = addresses
      .map((resolved) =>
        wildcards.has(resolved.address) ? { address: "127.0.0.1", family: 4 } : resolved,
      )
      .filter(({ address, family }) => own.check(address, family === 6 ? "ipv6" : "ipv4"));
    if (mine.length === 0) {
      return callback(new Error(`${target} resolves to no address of this container`), []);
    }
    callback(null, mine);
  });

// The client tries each address in turn, as the listener may have bound any of them, even where
// NODE_OPTIONS turns that off; the lookup above then always answers with every address.
setDefaultAutoSelectFamily(true);

// Node's HTTP client rather than fetch, which refuses ports browsers block, such as 6000, and IPv6
// addresses with a zone. Requesting localhost sends a valid Host header and invokes the lookup
// even when HOST is a numeric IP, which Node would otherwise dial without checking locality.
get(
  {
    hostname: "localhost",
    port,
    path: "/healthz",
    lookup: findOwnAddresses,
  },
  (response) => {
    response.resume();
    const status = response.statusCode ?? 0;
    if (status < 200 || status >= 300) fail(`/healthz answered ${status}`);
  },
).on("error", fail);
