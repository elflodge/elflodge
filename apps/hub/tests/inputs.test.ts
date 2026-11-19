import { getOpenAPIMeta } from "@orpc/openapi";
import { walkProcedureContractsAsync } from "@orpc/server";
import { apiContract } from "contract";
import { expect, test } from "vite-plus/test";

// Every API call refuses a parameter it does not define rather than run without it (ADR 0010).
// Checked on each input's top-level object; the batches tests send an unknown field nested in a job.
// The Runner's own calls ignore unknown fields instead, as the Runner protocol does (ADR 0026).

test("every public call declares BAD_REQUEST and refuses a parameter it does not define", async () => {
  await walkProcedureContractsAsync(apiContract, async (procedure, path) => {
    const name = path.join(".");
    const { inputSchemas = [], errorMap } = procedure["~orpc"];
    expect(inputSchemas, name).not.toHaveLength(0);
    expect(errorMap, name).toHaveProperty("BAD_REQUEST");
    for (const schema of inputSchemas) {
      // The upload's input is oRPC's request parts: oRPC fills the outer object and `headers` with
      // more than the call reads, so they stay open, and only `params` is the caller's to check.
      const stray =
        getOpenAPIMeta(procedure)?.inputStructure === "detailed"
          ? { params: { strayParameter: 1 } }
          : { strayParameter: 1 };
      const result = await schema["~standard"].validate(stray);
      const messages = (result.issues ?? []).map((issue) => issue.message);
      expect(messages.join("\n"), name).toContain("strayParameter");
    }
  });
});
