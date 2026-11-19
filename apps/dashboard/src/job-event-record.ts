import {
  JOB_CANCELLED,
  JOB_FAILED,
  JOB_PAUSED,
  JOB_RECOVERED,
  JOB_RESUMED,
  JOB_STARTED,
  JOB_SUCCEEDED,
  jobEndingSchema,
  jobFailureSchema,
  jobOpeningSchema,
  jobPauseSchema,
  jobSuccessSchema,
  type JobEvent,
} from "contract";
import * as z from "zod/mini";

// The contract keeps an open journal record. Read only what the row shows, leaving the original
// Event available when an extension or a later Runner writes a different shape.
const conversation = z.object({
  owner: z.optional(z.object({ conversationId: z.int() })),
  parent: z.optional(z.object({ conversationId: z.int(), at: z.int() })),
});
const text = z.object({ type: z.literal("text"), text: z.string() });
const image = z.object({ type: z.literal("image"), mimeType: z.string() });
const thinking = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
  redacted: z.optional(z.boolean()),
});
const toolCall = z.object({
  type: z.literal("toolCall"),
  name: z.string(),
  id: z.string(),
  arguments: z.record(z.string(), z.unknown()),
});
export type EventToolCall = z.infer<typeof toolCall>;

const time = z.pick(jobOpeningSchema, { timestamp: true });
const user = z.extend(time, {
  role: z.literal("user"),
  content: z.union([z.string(), z.array(z.discriminatedUnion("type", [text, image]))]),
});
const assistant = z.extend(time, {
  role: z.literal("assistant"),
  content: z.array(z.discriminatedUnion("type", [text, thinking, toolCall])),
  stopReason: z.string(),
  errorMessage: z.optional(z.string()),
  provider: z.string(),
  model: z.string(),
  usage: z.object({
    totalTokens: z.number(),
    cost: z.object({ total: z.number(), totalFromProvider: z.optional(z.boolean()) }),
  }),
});
const toolResult = z.extend(time, {
  role: z.literal("toolResult"),
  content: z.array(z.discriminatedUnion("type", [text, image])),
  toolCallId: z.string(),
  toolName: z.string(),
  isError: z.boolean(),
});
const entry = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal([JOB_STARTED, JOB_RESUMED, JOB_RECOVERED]), data: jobOpeningSchema }),
  z.object({ kind: z.literal(JOB_PAUSED), data: jobPauseSchema }),
  z.object({ kind: z.literal(JOB_CANCELLED), data: jobEndingSchema }),
  z.object({ kind: z.literal(JOB_FAILED), data: jobFailureSchema }),
  z.object({ kind: z.literal(JOB_SUCCEEDED), data: jobSuccessSchema }),
  z.object({ kind: z.literal("pi.assistant"), model: z.tuple([assistant]) }),
  z.object({ kind: z.literal("pi.user"), model: z.tuple([user]) }),
  z.object({ kind: z.literal("pi.tool-result"), model: z.tuple([toolResult]) }),
  z.object({
    kind: z.literal("pi.compaction"),
    model: z.tuple([user]),
    data: z.object({ reason: z.string() }),
  }),
  z.object({ kind: z.literal("pi.reset"), model: z.optional(z.tuple([user])) }),
  z.object({
    kind: z.literal("pi.system"),
    model: z.tuple([z.extend(time, { role: z.literal("system") })]),
  }),
]);

export function readJobEvent(event: JobEvent) {
  const parsed = event.type === "entry" ? z.safeParse(entry, event.record) : undefined;
  const record = parsed?.data;
  const relation =
    event.type === "conversation" ? z.safeParse(conversation, event.record).data : undefined;
  const message = record && "model" in record ? record.model?.[0] : undefined;
  const data = record && "data" in record ? record.data : undefined;
  const opening =
    record?.kind === JOB_STARTED || record?.kind === JOB_RECOVERED || record?.kind === JOB_RESUMED
      ? record.data
      : undefined;
  const at = data && "timestamp" in data ? data.timestamp : message?.timestamp;
  const conversationId = event.type === "conversation" ? event.id : event.record["conversationId"];
  return {
    event,
    id: event.id,
    kind: event.type === "conversation" ? "conversation" : event.record.kind,
    record,
    relation,
    // A new kind fails at the discriminator. A known kind can fail within its model or data.
    unreadable:
      event.type === "conversation"
        ? !relation
        : !!parsed?.error && parsed.error.issues[0]?.path[0] !== "kind",
    ownerId: relation?.owner?.conversationId,
    conversationId: typeof conversationId === "number" ? conversationId : undefined,
    at: at === undefined ? undefined : new Date(at),
    runId: opening?.runId,
    providerModel:
      message?.role === "assistant" ? `${message.provider}/${message.model}` : undefined,
    runner: data !== undefined && "timestamp" in data,
    isError:
      record?.kind === JOB_FAILED ||
      (message?.role === "assistant" && message.stopReason === "error") ||
      (message?.role === "toolResult" && message.isError),
  };
}

export type ReadJobEvent = ReturnType<typeof readJobEvent>;
