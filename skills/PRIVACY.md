# Privacy

Elflodge Agent Batches is a set of instructions for Claude. It adds no telemetry and no hosted service, and installing it does not give its maintainers access to your deployment.

Claude reads the inputs and results it prepares or inspects for you. That is handled under the terms of your Claude plan or provider, as in any other session.

## Where your data goes

When you run a batch:

- **The deployment you choose.** Your work goes to an Elflodge server run by you or another operator. It stores the inputs, job records, events and outputs. Outputs you collect are also saved on your machine.
- **The model provider.** The deployment sends the inputs, instructions and tool outputs a job needs to the model provider configured for it.
- **The web.** Jobs with web tools can send search queries and fetch websites. Where jobs run on a ChatGPT subscription, web search is available by default. See the [search settings](https://github.com/elflodge/elflodge/blob/main/apps/runner/README.md).

Setup downloads software and examples from npm, GitHub and container registries.

## Retention and deletion

The deployment's operator decides how long its stored data is kept and how it is deleted. Stopping the deployment's services does not delete what is stored.

Model providers, search providers, websites and download sources process and retain what they receive under their own terms.

## Questions

For data held in a deployment, ask its operator. For questions about the plugin, use the public [issue tracker](https://github.com/elflodge/elflodge/issues).
