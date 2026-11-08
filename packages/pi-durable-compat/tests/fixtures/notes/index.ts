import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@mariozechner/pi-ai";

// An extension using what extensions commonly use: tools, saved entries read back from the
// session, a `tool_call` gate and an `input` transform, with Pi's former package names.
export default function extension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "remember",
    label: "Remember",
    description: "Save a note",
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
    async execute(_id, params) {
      pi.appendEntry("note", { text: params.text, tags: params.tags });
      return { content: [{ type: "text", text: `Saved ${params.text}` }], details: {} };
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
  pi.on("input", (event) => ({ action: "transform", text: `${event.text}!` }));
}
