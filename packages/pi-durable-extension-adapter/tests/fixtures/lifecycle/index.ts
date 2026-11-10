import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// An extension that follows a run as observability and prompt extensions do: it adds to the
// system prompt, sends a message with the prompt and selects the active tools in
// `before_agent_start`, and records the lifecycle events, which its tool returns, reporting
// progress after, and it saves at the end of the session. It registers tools just before and after its selection, as extensions that
// register tools when a run starts do beside another that selects them.
export default function extension(pi: ExtensionAPI) {
  const seen: string[] = [];
  const events = [
    "agent_start",
    "turn_start",
    "message_end",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "turn_end",
    "agent_end",
    "agent_settled",
  ] as const;
  for (const event of events) pi.on(event, () => void seen.push(event));
  // What it saw by the end of the session, and how full the context was, kept with the conversation.
  pi.on("session_shutdown", (_event, ctx) =>
    pi.appendEntry("seen", { events: seen, usage: ctx.getContextUsage() }),
  );
  pi.on("before_agent_start", (event) => {
    seen.push(`before_agent_start ${event.prompt}`);
    event.systemPromptOptions.sections.notes = "Answer in French.";
    pi.registerTool(tool("earlier"));
    pi.setActiveTools([...pi.getActiveTools().filter((name) => name !== "dropped"), "events"]);
    pi.registerTool(tool("later"));
    return { message: { customType: "reminder", content: "Remember the notes.", display: false } };
  });
  pi.registerTool(tool("dropped"));
  pi.registerTool({
    name: "events",
    label: "Events",
    description: "List the events so far",
    parameters: Type.Object({}),
    defaultActive: false,
    async execute(_id, _params, _signal, onUpdate) {
      const text = seen.join(", ");
      onUpdate?.({ content: [{ type: "text", text: "listed" }], details: {} });
      return { content: [{ type: "text", text }], details: {} };
    },
  });
}

function tool(name: string) {
  return {
    name,
    label: name,
    description: `Returns ${name}`,
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text" as const, text: name }], details: {} };
    },
  };
}
