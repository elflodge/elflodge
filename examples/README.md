# Examples

Five everyday jobs for a business, each a folder you can run as it is and then point at your own files. Each folder holds the agent, in `instructions.txt` and `schema.json`, and made-up inputs in `inputs/`. Every input becomes one job, and every job comes back as JSON that matches the schema, or as a failure with its reason.

| Folder                               | Each job                                                              | Comes back with                                                                                          |
| ------------------------------------ | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [`invoices`](invoices)               | a PDF from a supplier's email, in English, German, French or Japanese | whether it is an invoice or credit note, its supplier, number, date and amounts, and whether they add up |
| [`sales-reports`](sales-reports)     | one shop's till export for a month, as CSV                            | revenue, refunds, orders, top products and odd days, with the script that worked them out                |
| [`contracts`](contracts)             | a supplier contract, with any amendments                              | when it can end, the last day to give notice, its yearly cost, and the clause the dates come from        |
| [`support-tickets`](support-tickets) | a customer's email to a support team                                  | category, urgency, a one-line summary and a draft reply                                                  |
| [`product-catalog`](product-catalog) | one supplier's price list, as CSV, JSON, a table or an email          | each product's title, category, weight in grams, colours and price, in the shop's own format             |

## Run one

Clone the repository, copy an example out of it, and run everything from the copy: inside the repository, npm refuses to run `npx`, because the repository asks its contributors for pnpm. You need Docker and Node, as for [the first job in the README](../README.md#an-everyday-chore-done-by-an-agent).

```sh
git clone https://github.com/elflodge/elflodge
cp -r elflodge/examples/invoices invoices
cd invoices
npx elflodge stack start --provider openrouter --model deepseek/deepseek-v4.1-flash-1017
npx elflodge batches submit --id invoices --each inputs/* \
  --instructions "$(cat instructions.txt)" --output-schema schema.json \
  --wait --output-dir results
```

`stack start` runs a hub, a Runner and Postgres in the background and, the first time, asks for your OpenRouter key; the model is the one our runs below used. `results/output.jsonl` gets one line per input that succeeded, and `results/error.jsonl`, only if some failed, one line per input that did not. Use another folder's name in place of `invoices` for the others.

To use your own files, put them in `inputs/` in place of ours, and change `instructions.txt` and `schema.json` to say what you want back. Give every new run a new `--id` and a new `--output-dir`: under the same ID, the hub refuses a changed agent or a changed input and returns the earlier results for unchanged ones, and the command does not overwrite a results folder.

## What our run gave

We ran each folder once on 2026-11-07 with `deepseek/deepseek-v4.1-flash-1017` through OpenRouter. Every job succeeded, and the inputs hide a few things to catch:

| Folder            | Jobs | Model cost | Time | What to look for                                                                                                           |
| ----------------- | ---- | ---------- | ---- | -------------------------------------------------------------------------------------------------------------------------- |
| `invoices`        | 7    | 0.3¢       | 20 s | The Morgenfeld invoice's total is €10 too high, and one PDF is Harbor & Pine's delivery note for the goods on its invoice. |
| `sales-reports`   | 6    | 0.9¢       | 63 s | Each shop but Market Square has a missing day, a large refund or a mistyped quantity.                                      |
| `contracts`       | 6    | 0.5¢       | 42 s | Some notice dates have already passed, one amendment changes the term and the notice period, and the lease never renews.   |
| `support-tickets` | 6    | 0.2¢       | 28 s | The last email is both a billing complaint and a how-to question, so its reply must answer both.                           |
| `product-catalog` | 6    | 0.5¢       | 30 s | Weights arrive in pounds, ounces and kilograms, and one supplier sells only dog gear, which this shop does not stock.      |

In our run, the agent got all of these right. Model cost is what OpenRouter billed; the CLI prints a higher estimate, from the model's list price in Pi's catalogue. Time runs from the first job's start to the last one's end. The contract dates count from the day you run it, so yours will differ. The answers come from the model: read some before trusting a thousand.
