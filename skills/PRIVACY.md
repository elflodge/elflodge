# Elflodge Agent Batches privacy notice

This notice covers the Elflodge Agent Batches Claude plugin. The plugin contains instructions for using the open-source Elflodge software; it does not provide a hosted Elflodge account or run an Elflodge service for you. Its software license is [MIT](LICENSE).

## Data used when you run work

Installing the plugin does not submit jobs. When you ask Claude to use it, Claude reads the task and files you provide and can run the Elflodge CLI. Those inputs may contain personal data. Claude's processing is governed by your Anthropic account's terms and privacy settings.

The CLI sends the instructions and inputs you submit to your configured Elflodge hub. Your Runner processes the jobs and sends model requests, which can include file content and tool outputs, to its configured model provider. The hub and Runner are operated by you or the deployment operator you choose, not by installing this plugin.

Enabled web tools can send search queries to configured search providers and fetch URLs from websites. A Runner using a ChatGPT subscription can search through that subscription by default. See the [Runner's web access documentation](https://github.com/elflodge/elflodge/blob/main/apps/runner/README.md) for configuration and limits. Choose the deployment, model provider and web access settings before submitting private data.

Setup commands can contact npm, GitHub and container registries to download software and examples. These services receive the requests needed for those downloads. The plugin adds no telemetry, MCP server or background hooks of its own.

## Storage and retention

Your deployment stores submitted inputs, job records, events and outputs. The CLI writes collected outputs to the directory you select. Retention depends on the deployment's configuration and its operator; the plugin does not impose a retention period. Stopping the local stack preserves its data. Deleting a local output file does not delete the deployment's records, provider copies or backups.

Contact your deployment operator to access or delete data held there. Model and search providers, websites contacted by tools, and Anthropic have their own processing and retention practices. Review the policies of the services you choose. Removing the plugin does not delete data already submitted to those services.

## Support

Use the [project's issue tracker](https://github.com/elflodge/elflodge/issues) for plugin problems. Issues are public: do not include credentials, private documents or personal data. The plugin maintainers do not gain access to your deployment merely because you install the plugin.
