# agent-batch

agent-batch is now [Elflodge](https://elflodge.com), with its source at [elflodge/elflodge](https://github.com/elflodge/elflodge). This package installs the `elflodge` package and runs it under the old command name, so `npx agent-batch` keeps working. New installs should use `elflodge`.

For batch document extraction, classification and other repeated agent tasks, install the [Elflodge skill](https://github.com/elflodge/elflodge/tree/main/skills/elflodge-batch-automation):

```sh
npx skills add elflodge/elflodge --skill elflodge-batch-automation
```
