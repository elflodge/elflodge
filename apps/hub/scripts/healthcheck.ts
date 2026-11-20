import { lookup } from "node:dns/promises";

const host = process.env.HOST;
// A wildcard bind accepts connections on loopback in its address family.
const target = host === "::" ? "::1" : !host || host === "0.0.0.0" ? "127.0.0.1" : host;
try {
  // Resolve like the listener. A direct fetch of localhost in Docker can try only IPv4
  // even when the listener resolved it to ::1.
  const { address, family } = await lookup(target);
  const hostname = family === 6 ? `[${address}]` : address;
  const response = await fetch(`http://${hostname}:${process.env.PORT ?? 8787}/healthz`);
  process.exitCode = response.ok ? 0 : 1;
  await response.body?.cancel();
} catch {
  process.exitCode = 1;
}
