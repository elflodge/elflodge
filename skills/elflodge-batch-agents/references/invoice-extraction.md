# A small invoice extraction pilot

This uses synthetic text invoices so the result is independently checkable and no PDF tooling is required. Run it in a new working directory. An existing authenticated hub or a local stack is required; model calls may cost money.

```sh
mkdir pilot
cat > pilot/alder.txt <<'EOF'
Alder Supplies
Invoice: AL-104
Currency: GBP
Subtotal: 100.00
Tax: 20.00
Total payable: 120.00
EOF
cat > pilot/birch.txt <<'EOF'
Birch Studio
Invoice: BS-209
Total payable: $48.50
No currency code stated.
EOF
cat > invoice.schema.json <<'EOF'
{
  "type": "object",
  "properties": {
    "supplier": { "type": ["string", "null"] },
    "number": { "type": ["string", "null"] },
    "currency": { "type": ["string", "null"] },
    "total": { "type": ["number", "null"] }
  },
  "required": ["supplier", "number", "currency", "total"],
  "additionalProperties": false
}
EOF
npx elflodge batches submit \
  --id invoices-pilot-v1 \
  --each pilot/*.txt \
  --instructions "Extract the supplier, invoice number, currency and total payable. Use null for missing fields; never infer a currency from an ambiguous symbol." \
  --output-schema invoice.schema.json \
  --wait \
  --wait-timeout 30m \
  --output-dir ./pilot-results-v1
```

Expected `output` values, matched to their `customId` paths:

| Input           | supplier       | number | currency | total |
| --------------- | -------------- | ------ | -------- | ----- |
| pilot/alder.txt | Alder Supplies | AL-104 | GBP      | 120   |
| pilot/birch.txt | Birch Studio   | BS-209 | null     | 48.5  |

Read every pilot result, including any `error.jsonl`. Alder checks total versus subtotal; Birch checks whether the agent invents a currency. This is a smoke test, not evidence that real scans, multiple currencies, credit notes or unusual layouts work. Add representative real cases and expected answers before processing the full collection.

For PDF inputs, first verify the Runner can read them with the tools available, or preprocess them into text/images. Then replace the input glob with `invoices/*.pdf`, choose a new Batch ID and a fresh results directory. Keep instructions and schema unchanged within a Batch. If tuning them, submit a new pilot with a new ID.

The workflow returns JSON results. It does not export agent-generated files as job artifacts.
