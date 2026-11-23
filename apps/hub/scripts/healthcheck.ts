import { get } from "node:http";

// Node's HTTP client rather than fetch, which refuses ports browsers block, such as 6000, and IPv6
// addresses with a zone. It tries every address a name resolves to, as the listener may have bound
// either. Node binds `::` to IPv4 too, so a wildcard bind is probed on IPv4 loopback, which a
// container has even with IPv6 disabled.
const host = process.env.HOST;
const target = !host || host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
get({ host: target, port: process.env.PORT ?? 8787, path: "/healthz" }, (response) => {
  const status = response.statusCode ?? 0;
  process.exitCode = status >= 200 && status < 300 ? 0 : 1;
  response.resume();
}).on("error", (error) => {
  // Docker keeps the probe's output in the container's health log.
  console.error(error);
  process.exitCode = 1;
});
