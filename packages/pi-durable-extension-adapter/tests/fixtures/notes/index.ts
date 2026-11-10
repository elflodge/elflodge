import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@mariozechner/pi-ai";

// An extension using what extensions commonly use: tools, saved entries read back from the
// session, a `tool_call` gate, an `input` transform, a prompt of its own and a `context` handler,
// with Pi's former package names. A tool brings a prompt snippet and guidelines.
export default function extension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "remember",
    label: "Remember",
    description: "Save a note",
    promptSnippet: "Save a note\n  for later",
    promptGuidelines: ["Save each note once", " Save each note once "],
    parameters: Type.Object({ text: Type.String(), tags: Type.Array(Type.String()) }),
    // Tags sent as JSON text are parsed, as `pi-web-access` does for its arrays.
    prepareArguments: (args) => {
      if (
        typeof args !== "object" ||
        args === null ||
        !("tags" in args) ||
        typeof args.tags !== "string"
      ) {
        return args;
      }
      return { ...args, tags: JSON.parse(args.tags) };
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      pi.appendEntry("note", { text: params.text, tags: params.tags });
      // Read back at once, as an extension does that keeps its state in the session.
      const count = ctx.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "custom" && entry.customType === "note").length;
      return { content: [{ type: "text", text: `Saved ${params.text} (${count})` }], details: {} };
    },
  });
  pi.registerTool({
    name: "recall",
    label: "Recall",
    description: "List the saved notes",
    parameters: Type.Object({ order: StringEnum(["oldest", "newest"] as const) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const notes = ctx.sessionManager
        .getBranch()
        .flatMap((entry) =>
          entry.type === "custom" && entry.customType === "note" ? [entry.data] : [],
        );
      if (params.order === "newest") notes.reverse();
      return { content: [{ type: "text", text: JSON.stringify(notes) }], details: {} };
    },
  });
  pi.registerTool({
    name: "danger",
    label: "Danger",
    description: "Never allowed",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "ran" }], details: {} };
    },
  });
  pi.registerTool({
    name: "nudge",
    label: "Nudge",
    description: "Ask again after this run",
    parameters: Type.Object({}),
    async execute() {
      pi.sendUserMessage("Check the notes", { deliverAs: "followUp" });
      return { content: [{ type: "text", text: "nudged" }], details: {} };
    },
  });
  // Blocks `danger`, and a second save of a note already saved, which it reads from the session.
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName === "danger") return { block: true, reason: "Not allowed" };
    if (event.toolName !== "remember") return undefined;
    const saved = ctx.sessionManager
      .getBranch()
      .some(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === "note" &&
          entry.data?.text === event.input.text,
      );
    return saved ? { block: true, reason: "Already saved" } : undefined;
  });
  // Marks each input with where it came from, and how it is to be queued while a run is under way.
  pi.on("input", (event) => ({
    action: "transform",
    text: `${event.text} (${[event.source, event.streamingBehavior].filter(Boolean).join(", ")})`,
  }));
  // Leaves the request as it is, which keeps the system prompt.
  pi.on("context", () => undefined);
  // A tool named by the conversation's configuration, as an MCP server's tools are.
  pi.registerFlag("tool", { type: "string", default: "", description: "Name of an extra tool" });
  pi.on("session_start", () => {
    const name = pi.getFlag("tool");
    if (typeof name !== "string" || name === "") return;
    pi.registerTool({
      name,
      label: name,
      description: `The ${name} tool`,
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: name }], details: {} };
      },
    });
  });
}
