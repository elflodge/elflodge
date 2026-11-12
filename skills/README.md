# Elflodge Agent Batches

Too much repetitive work for one conversation? Let Claude hand it off to hundreds of sandboxed Pi agents working in parallel on your own machine. They run unattended and return structured results your code can use.

It suits work where every item gets the same treatment but each one needs judgment: invoices to extract, documents to classify, records to enrich. You describe one unit of work and what a good answer looks like. Claude helps you write the instructions and an output schema, and try them on a few items before you run the rest.

Each item becomes one job, with its files and a shell in its own sandbox. Successful outputs are collected as JSON records. For an invoice task, a record might look like this:

```json
{"customId": "invoice-0042.pdf", "status": "succeeded", "output": {"invoice_number": "INV-2291", "total": 1840.5, "due_date": null}}
```

The fields inside `output` are whatever your schema defines. Successful records are collected in `output.jsonl`, and failures, with their reasons, in `error.jsonl`.

A batch starts with a few jobs and pauses if they fail, catching execution problems before they affect the whole run. It keeps running after the conversation ends, and Claude can reconnect later to collect the results. A local deployment runs eight jobs at a time by default; raise that as your machine and your model provider's rate limits allow.

## Get started

You need Claude Code with terminal access and Node.js 22.19 or later. Connect to an Elflodge deployment you already have, or let Claude set one up on your machine with Docker and a model-provider sign-in. The [deployment guide](https://github.com/elflodge/elflodge/blob/main/docs/deploy.md) covers host requirements.

Once the plugin is installed, ask Claude:

> Use Elflodge to try the invoice extraction example. Help me set it up and show me the results before we run a larger batch.

Then describe your own task and inputs the same way. Every output is checked against your schema, which catches malformed answers but not wrong ones, so compare a few with their sources before you scale up.

## What it uses and where your data goes

The plugin is a single skill: instructions that teach Claude to use Elflodge. When you ask for a batch, Claude runs the `elflodge` CLI from npm. If you set up a local deployment, it starts Docker services from Elflodge's published images, and if you try the invoice example, it downloads it from GitHub.

Your instructions and input files go to the Elflodge deployment you use, which sends what each job needs to its model provider. Jobs with web tools enabled can also send search queries and fetch websites. Collected results are saved on your machine. Model usage and hosting can cost money, depending on the provider and models you choose. The [privacy notice](PRIVACY.md) covers data handling and retention.

[Website](https://elflodge.com) · [GitHub](https://github.com/elflodge/elflodge) · [CLI reference](https://github.com/elflodge/elflodge/blob/main/docs/cli.md) · [Report a problem](https://github.com/elflodge/elflodge/issues) · [MIT license](LICENSE)
