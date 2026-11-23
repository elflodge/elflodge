import { lookup } from "node:dns";
import { get } from "node:http";

// Docker keeps the probe's output in the container's health log.
function fail(reason: unknown) {
  console.error(reason);
  process.exitCode = 1;
}

const host = process.env.HOST;
const port = process.env.PORT ?? 8787;
// Node binds `::` to IPv4 too, so a wildcard bind is probed on IPv4 loopback, which a container
// keeps without IPv6.
const target = !host || host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
// Node's HTTP client rather than fetch, which refuses ports browsers block, such as 6000, and IPv6
// addresses with a zone. Such an address is no valid Host header, so a fixed one is sent.
get(
  {
    host: target,
    port,
    path: "/healthz",
    headers: { host: `localhost:${port}` },
    // The client tries every address the name resolves to, as the listener may have bound any of
    // them. Without this lookup it would skip IPv6 addresses on a network without IPv6, though the
    // listener may have bound ::1 for localhost; Node's connect turns `hints: 0` into that filter.
    lookup: (hostname, options, callback) => lookup(hostname, { ...options, hints: 0 }, callback),
  },
  (response) => {
    response.resume();
    const status = response.statusCode ?? 0;
    if (status < 200 || status >= 300) fail(`/healthz answered ${status}`);
  },
).on("error", fail);
