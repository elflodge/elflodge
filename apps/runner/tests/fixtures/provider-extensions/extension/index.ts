import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// An extension that points Groq at a proxy of its own for each job, `PROXY_URL` followed by the
// job's ID, which it reads from the job's Workspace, `<jobs>/<job ID>/workspace`.
export default function extension(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    const job = path.basename(path.dirname(ctx.cwd));
    pi.registerProvider("groq", { baseUrl: `${process.env.PROXY_URL}/${job}/v1` });
  });
}
