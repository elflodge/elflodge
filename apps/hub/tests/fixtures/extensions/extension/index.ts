import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// An extension whose tool runs a command, as a Pi extension's tools do through `pi.exec`, and
// answers with what it printed: here the job's Input file, read from the working directory.
export default function extension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "show_file",
    label: "Show file",
    description: "Prints a file of the Workspace.",
    parameters: Type.Object({ path: Type.String() }),
    async execute(_id, { path }, signal) {
      const { stdout, code } = await pi.exec("cat", [path], { signal });
      if (code !== 0) throw new Error(`cat exited with ${code}`);
      return { content: [{ type: "text", text: stdout }], details: undefined };
    },
  });
}
