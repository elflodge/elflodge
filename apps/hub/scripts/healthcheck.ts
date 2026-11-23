import { get } from "node:http";

// A deployment that binds only to another interface can pass its local address in the health command.
const host = process.argv[2] ?? "127.0.0.1";
const port = process.env.PORT ?? 8787;

// Check the hub directly even when Node is configured to use an HTTP proxy.
get({ host, port, path: "/healthz", agent: false }, (response) => {
  response.resume();
  const status = response.statusCode ?? 0;
  if (status < 200 || status >= 300) {
    console.error(`/healthz answered ${status}`);
    process.exitCode = 1;
  }
}).on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
