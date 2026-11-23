import { lookup } from "node:dns/promises";
import { get } from "node:http";

// Docker keeps the probe's output in the container's health log.
function fail(reason: unknown) {
  console.error(reason);
  process.exitCode = 1;
}

const host = process.env.HOST;
const port = process.env.PORT ?? 8787;
try {
  // Resolve like the listener, without the client's own lookup, which skips IPv6 on a network
  // without it although the listener may have bound ::1 for localhost. Node binds `::` to IPv4
  // too, so a wildcard bind is probed on IPv4 loopback, which a container keeps without IPv6.
  const target = !host || host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const { address } = await lookup(target);
  // Node's HTTP client rather than fetch, which refuses ports browsers block, such as 6000, and
  // IPv6 addresses with a zone. Such an address is no valid Host header, so a fixed one is sent.
  get(
    { host: address, port, path: "/healthz", headers: { host: `localhost:${port}` } },
    (response) => {
      response.resume();
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) fail(`/healthz answered ${status}`);
    },
  ).on("error", fail);
} catch (error) {
  fail(error);
}
