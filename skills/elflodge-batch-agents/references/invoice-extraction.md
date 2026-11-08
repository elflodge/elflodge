# Run the released invoice example

Use the maintained [invoice example from Elflodge 0.7.1](https://github.com/elflodge/elflodge/tree/v0.7.1/examples/invoices). Its seven synthetic PDFs include different languages, a credit note, a delivery note and an incorrect total. The instructions ask the agent to read each PDF, classify it, extract its facts and check the arithmetic with code. The schema also gives downstream code a `totalsAddUp` flag and notes for human review.

## Check PDF tooling

Inspect representative PDFs before selecting tooling: they may contain text, scans, tables or multiple documents. The standard Docker Runner includes `pdftotext` and `pdftoppm` for text extraction and page rendering. Scanned pages need an image-capable model or an OCR step. Verify these tools on custom Runners.

## Prepare and submit

Use a new working directory with Git and Node available. Copy the example outside the source checkout: the repository's contributor package-manager policy prevents `npx` there. The tag pins the inputs, instructions and schema; do not rewrite them just to run the example.

```sh
git clone --depth 1 --branch v0.7.1 \
  https://github.com/elflodge/elflodge elflodge-example-src
cp -R elflodge-example-src/examples/invoices invoice-pilot
cd invoice-pilot
```

Connect to the user's existing authenticated hub, or follow the skill's local stack setup. Use the configured model unless changing it is part of the user's request; the model is a Runner setting, not a Batch option.

```sh
npx elflodge batches submit \
  --id invoices-pilot-v1 \
  --each inputs/*.pdf \
  --instructions "$(cat instructions.txt)" \
  --output-schema schema.json \
  --wait \
  --wait-timeout 30m \
  --output-dir ./pilot-results-v1
```

## Check more than the output shape

Match each result's `customId` to its `inputs/` path and read its `output`. The following checks exercise distinctions that shape validation alone cannot catch:

| Input                                      | What to check                                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `inputs/morgenfeld-druck-R-88731.pdf`      | The stated total is €10 too high. Keep the stated figures, set `totalsAddUp` to false, and explain the mismatch in notes. |
| `inputs/harbor-pine-DN-2026-0398.pdf`      | Recognize a delivery note, use `documentType: "other"`, and leave amounts null.                                           |
| `inputs/bluefin-logistics-CN-2026-031.pdf` | Recognize a credit note and return negative amounts as instructed.                                                        |

Inspect all seven results and any `error.jsonl`, not just these checks. The [recorded run](https://github.com/elflodge/elflodge/blob/v0.7.1/examples/README.md#what-our-run-gave) provides historical results, not a test of your setup. Verify outputs on the selected model before relying on it.

Then try representative documents from the user's own collection. A fixed-format export with deterministic extraction rules is usually better handled by a script. Use agents where document variation needs judgment or adaptive inspection. Keep the checked instructions and schema for the full batch; use a new Batch ID and fresh output directory for changed inputs or instructions. The workflow returns JSON, not agent-generated file artifacts.
