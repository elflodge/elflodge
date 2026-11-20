import { ZodToJsonSchemaConverter } from "@orpc/zod";
import * as z from "zod/mini";

// A hub may add response members (ADR 0018). If an extra member rules out every branch of a
// union, oRPC cannot tell which dates to convert before the client validates the answer.
// Zod closes plain objects in output JSON Schema because it strips unknown keys. Its `toJSONSchema`
// has no option for open outputs. Removing the keyword in `override` is the way Zod's maintainer
// gives (colinhacks/zod#4564). Strict inputs keep their explicit catchall.
export const openOutputSchemaConverter = new ZodToJsonSchemaConverter({
  override: ({ zodSchema, jsonSchema }) => {
    if (zodSchema instanceof z.core.$ZodObject && zodSchema._zod.def.catchall === undefined) {
      delete jsonSchema.additionalProperties;
    }
  },
});
