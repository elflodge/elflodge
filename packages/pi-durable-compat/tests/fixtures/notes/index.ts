import { StringEnum, Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// An extension using what extensions commonly use: tools, saved entries read back from the
// session, a `tool_call` gate and an `input` transform, with Pi's former package names.
export default function notes(pi: ExtensionAPI) {
  pi.registerTool({
    name: "remember",
    label: "Remember",
    description: "Save a note",
    parameters: Type.Object({ text: Type.String(), tags: Type.Array(Type.String()) }),
    prepareArguments: (args) => args as { text: string; tags: string[] },
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
        .flatMap((entry) => (entry.type === "custom" && entry.customType === "note" ? [entry.data] : []));
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
  pi.on("tool_call", (event) => (event.toolName === "danger" ? { block: true, reason: "Not allowed" } : undefined));
  pi.on("input", (event) => ({ action: "transform", text: `${event.text}!` }));
}
