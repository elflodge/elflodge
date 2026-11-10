import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// An extension that follows a run as observability and prompt extensions do: it adds to the
// system prompt, sends a message with the prompt and activates a tool in `before_agent_start`, and
// records the lifecycle events, which its tool returns.
export default function extension(pi: ExtensionAPI) {
  const seen: string[] = [];
  const events = [
    "agent_start",
    "turn_start",
    "message_end",
    "tool_execution_start",
    "tool_execution_end",
    "turn_end",
    "agent_end",
  ] as const;
  for (const event of events) pi.on(event, () => void seen.push(event));
  pi.on("before_agent_start", (event) => {
    seen.push(`before_agent_start ${event.prompt}`);
    event.systemPromptOptions.sections.notes = "Answer in French.";
    pi.setActiveTools([...pi.getActiveTools(), "events"]);
    return { message: { customType: "reminder", content: "Remember the notes.", display: false } };
  });
  pi.registerTool({
    name: "events",
    label: "Events",
    description: "List the events so far",
    parameters: Type.Object({}),
    defaultActive: false,
    async execute() {
      return { content: [{ type: "text", text: seen.join(", ") }], details: {} };
    },
  });
}
