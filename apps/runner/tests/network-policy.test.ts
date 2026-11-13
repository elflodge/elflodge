import { createResolvedAddressGuard } from "@anthropic-ai/sandbox-runtime/dist/sandbox/resolved-address-guard.js";
import { expect, it } from "vite-plus/test";

import { type NetworkException, sandboxNetwork } from "../src/network.ts";

// The ask callback is the only check on an IP destination, and names are left to sandbox-runtime's
// resolved-address guard (ADR 0041), so these ask both directly, as sandbox-runtime's proxies do.

const host = ["192.168.7.20/32", "93.184.0.10/32"];

async function ask(exceptions: NetworkException[], destination: string, port = 80) {
  const { askCallback } = sandboxNetwork({ mode: "open", exceptions }, host);
  if (askCallback === undefined) throw new Error("an open network has an ask callback");
  const answer = await askCallback({ host: destination, port });
  return typeof answer === "boolean" ? (answer ? "allowed" : "refused") : answer.reason;
}

function permits(exceptions: NetworkException[], address: string, port = 80) {
  const { network } = sandboxNetwork({ mode: "open", exceptions }, host);
  const localAddresses = () => host.map((range) => range.split("/")[0] ?? range);
  return createResolvedAddressGuard({ ...network, localAddresses }).permits(
    "service.example",
    address,
    port,
  );
}

it("an IP destination in a refused range is refused with its class, however it is written", async () => {
  for (const [destination, refused] of [
    ["127.1", "Loopback addresses"],
    ["::ffff:10.0.0.5", "Private network addresses"],
    ["167772165", "Private network addresses"],
    ["169.254.169.254", "Link-local addresses"],
    ["168.63.129.16", "Cloud metadata addresses"],
    ["100.64.0.1", "Shared (carrier-grade NAT) addresses"],
    ["2001:db8::1", "Documentation addresses"],
    ["93.184.0.10", "Addresses of the Runner's own host"],
    // NAT64, 6to4 and IPv4-compatible forms of 10.0.0.5.
    ["64:ff9b::a00:5", "Private network addresses"],
    ["2002:a00:5::", "Private network addresses"],
    ["::a00:5", "Private network addresses"],
  ] as const) {
    expect(await ask([], destination), destination).toMatch(`${refused} are blocked`);
  }
  // Public addresses, a globally reachable row inside a reserved block, and a name.
  for (const destination of ["8.8.8.8", "2606:4700::1", "192.0.0.9", "example.com"]) {
    expect(await ask([], destination), destination).toBe("allowed");
  }
  expect(await ask([], "1.2.3.4.5")).toMatch("not a host name or IP address");
});

it("an exception opens an IP destination on its port, the Runner's own addresses too", async () => {
  const exceptions = [{ range: "10.0.0.0/8", port: 8080 }, { range: "10.1.0.0/16" }];
  expect(await ask(exceptions, "10.2.3.4", 8080)).toBe("allowed");
  expect(await ask(exceptions, "10.2.3.4", 22)).toMatch("only on the ports");
  expect(await ask(exceptions, "10.1.2.3", 22)).toBe("allowed");
  expect(await ask([{ range: "192.168.0.0/16" }], "192.168.7.20")).toBe("allowed");
});

it("a loopback, link-local or cloud metadata address opens only when an exception names it alone", async () => {
  for (const [range, destination] of [
    ["100.64.0.0/10", "100.100.100.200"],
    ["fd00::/8", "fd00:ec2::254"],
    ["169.254.0.0/16", "169.254.169.254"],
    ["127.0.0.0/8", "127.0.0.2"],
  ] as const) {
    expect(await ask([{ range }], destination), destination).toMatch("names the address itself");
    expect(
      await ask([{ range: `${destination}/${destination.includes(":") ? 128 : 32}` }], destination),
    ).toBe("allowed");
  }
  expect(await ask([{ range: "100.64.0.0/10" }], "100.64.0.1")).toBe("allowed");
});

it("a name is refused where it resolves into a refused range, unless an exception opens it there", () => {
  expect(permits([], "10.0.0.5")).toBe(false);
  expect(permits([], "93.184.0.10")).toBe(false);
  expect(permits([], "8.8.8.8")).toBe(true);
  expect(permits([{ range: "10.0.0.0/8" }], "10.0.0.5")).toBe(true);
  expect(permits([{ range: "10.0.0.5/32", port: 8080 }], "10.0.0.5", 8080)).toBe(true);
  expect(permits([{ range: "10.0.0.5/32", port: 8080 }], "10.0.0.5", 22)).toBe(false);
  expect(permits([{ range: "192.168.0.0/16" }], "192.168.7.20")).toBe(true);
});
