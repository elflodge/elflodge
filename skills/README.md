# Elflodge Agent Batches

Run batches of work with parallel agents on your own machine or an Elflodge deployment you control. This skill helps Claude prepare document extraction, classification and enrichment tasks, try representative inputs, submit the batch, inspect structured results and recover interrupted waiting.

## Requirements

Use Claude Code with a terminal, Node.js 22.19 or later, and access to an authenticated Elflodge hub. To start a local hub and Runner, you also need Docker and model-provider authentication. See the [deployment guide](https://github.com/elflodge/elflodge/blob/main/docs/deploy.md) for host requirements.

The plugin contains the [Agent Batches skill](elflodge-agent-batches/SKILL.md), not the Elflodge service. Installing it does not start services or submit work. Claude web chat does not gain access to your machine or Docker by installing this plugin. Other Claude environments need the same terminal and hub access before they can run jobs.

## Try it

Ask Claude:

- "Use Elflodge to run the released invoice example as a pilot. Check the document types and arithmetic before proposing a larger batch."
- "Prepare an Elflodge classification pilot for these documents. Use my categories, allow an uncertain result, and show me the instructions and schema before submitting."
- "My Elflodge batch stopped waiting. Inspect its status and collect the results without duplicating completed jobs."

Start with synthetic or non-sensitive inputs. The skill checks output structure and guides inspection; schema-valid results can still be factually wrong. Running jobs can incur model-provider and hosting costs.

## What runs and where data goes

When following the skill, Claude can download and run the `elflodge` CLI from npm, fetch the released invoice example from GitHub, and start Docker services using Elflodge's published images. These happen while carrying out your request, not on plugin installation.

Submitted instructions and input files go to your configured Elflodge hub and Runner. The Runner sends model requests, which can include input content and tool results, to its configured model provider. Job records, events and results are stored by your deployment; collected results are also written to the output directory you choose. Stopping the local stack preserves its data. Provider retention and processing depend on the provider you choose.

The CLI uses your configured hub credentials; provider authentication belongs to the Runner setup. Do not paste secrets into prompts or output files. Review the deployment and provider before submitting private data. The plugin adds no MCP server, hooks or telemetry code.

[CLI reference](https://github.com/elflodge/elflodge/blob/main/docs/cli.md) · [Report a problem](https://github.com/elflodge/elflodge/issues) · [MIT license](LICENSE)

## Maintainer checks

The plugin root is this `skills/` directory. Its manifest points to the canonical skill directly, so Claude, Codex, Pi and skills.sh use the same instructions. Submit this subfolder rather than the application repository root. Release Please updates the plugin version with the software release.

From the repository root, validate and load it locally:

```sh
claude plugin validate --profile directory --strict ./skills
claude --plugin-dir ./skills
```

Invoke `/elflodge:elflodge-agent-batches` in that session. Local validation checks packaging; run the directory portal's validation separately for its policy scan before submission. See [Anthropic's checklist](https://claude.com/docs/plugins/pre-submission-checklist).

The 512-pixel PNG icon is a raster export of the [website favicon](https://github.com/elflodge/site/blob/main/public/favicon.svg).
