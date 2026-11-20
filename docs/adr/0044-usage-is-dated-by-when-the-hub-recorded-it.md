# Usage is dated by when the hub recorded it

`GET /usage` adds up the Organization's Usage records by UTC day, and dates each record by `recordedAt`, not by the job's `endedAt`. `recordedAt` is Postgres's `now()` in the transaction that writes the record, the one that records the job's end: when that transaction began, by the database's clock, not by the hub's clock that other columns record. A record's `recordedAt` is set as it is written and never changes, though deleting its job later updates other fields of the record, so nothing a Runner reports later moves a record to another day. A day that has passed therefore keeps its usage, but for one case: a transaction that begins before UTC midnight and commits after it adds to the day before, which a read in between has shown without it. That window lasts as long as the transaction, which can be longer than its few statements take, as it may wait on row locks. A month keeps its usage the same way, with the same case at its last midnight. This is what someone who compares a day's or a month's figure with what they read before expects to stay put. Records written before the column existed take their `endedAt`.

`endedAt` is the job's own end. For an end a Runner reports, it comes from the Runner's journal, by the Runner's clock, and the report can reach the hub long after the end: a Runner cut off from the hub keeps its jobs running and reports their ends once it reconnects, and a Runner that restarts reports from its journal. Dated by `endedAt`, such an end would add to a day already read, changing a total someone may have acted on, and a clock the hub does not control would decide which day work counts in. The record keeps `endedAt` for what it says about the job.

Days are UTC days, as the API's instants are in UTC, so a day is the same for every caller. Should Usage records grow large enough to be partitioned by month, the partitions would be keyed by the same time: one keyed by `recordedAt` takes rows after its month has passed only from transactions that began before its end, while one keyed by `endedAt` could take a late report's at any time.

The hub uses its own clock to resolve the days a caller asks for, whether the caller gives a number of days, a calendar month or dates. It reads the clock once. The answer gives that instant as `readAt`, and its UTC day as `today`, so every caller can say which day is still being recorded. The window ends at the earlier of the requested end and today. The hub refuses a window whose first day has yet to begin.

Each UTC day carries only its totals. A grouped read computes the daily totals and whole-window group rankings in one SQL statement, so both use one snapshot. Groups beyond the limit are summed as `other`.

## Considered options

- Dating by `endedAt`: a late report changes a past day and month, the Runner's clock decides the day, and a partition by it never closes.
- Dating by the job's `createdAt`: a long job counts on the day it was submitted, and each later end of a resumed job adds to a day long past.
- Putting groups inside each day: Batches and label values have no upper bound, and ranking them over the window needs only one total per group. OpenAI's Organization [Usage][openai-usage] and [Costs][openai-cost] APIs, Anthropic's Admin [usage][admin-usage] and [cost][admin-cost] reports, and AWS Cost Explorer's [`GetCostAndUsage`][aws] put groups inside time buckets, which works for a handful of models, projects or keys. [Anthropic's successor analytics API][analytics] ranks flat rows over the range with a page limit. [Azure Cost Management Query][azure] also returns flat rows.
- Reading `today`, `readAt` and the window from Postgres would use the clock that dates `recordedAt`. The hub needs to resolve and validate the window before the report statement. Reading the database clock first would add a round trip, which on the Workers hub crosses Hyperdrive.
- Resolving the window on the caller's clock can put its last day in the future if the clock is ahead. A browser using local dates west of UTC can mark yesterday as the day still being recorded.
- Taking `days` and `month` separately would require each to rule out the other as well as `from` and `to`. The answer already uses `days` for its rows.
- Putting a flag on each row would send up to 400 flags to identify one UTC day. A caller can compare each row's date with `today`.
- Giving only `readAt` would leave each caller to work out the UTC day from that instant.

[openai-usage]: https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/completions
[openai-cost]: https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs
[admin-usage]: https://platform.claude.com/docs/en/api/beta/organization/usage_report/retrieve_messages
[admin-cost]: https://platform.claude.com/docs/en/api/beta/organization/cost_report/retrieve
[aws]: https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_GetCostAndUsage.html
[analytics]: https://platform.claude.com/docs/en/manage-claude/usage-cost-analytics-api
[azure]: https://learn.microsoft.com/en-us/rest/api/cost-management/query/usage?view=rest-cost-management-2026-06-01

## Consequences

An end the hub learns of late counts on the day it learns of it, so a Runner that reconnects after midnight adds the previous day's work to the new day. The `recordedAt` index supports reads over a window of days.

If the hub and Postgres are on different sides of UTC midnight, “so far” can mark the wrong day. An end Postgres records today can fall after the answer’s `to`.

## When to reconsider

When callers need usage dated by when the work happened, as to compare it with a model provider's bill, which dates each call, and accept that past days can change: the record keeps `endedAt` for that.

Reconsider the grouping when a chart needs to stack groups by day or a caller needs every group in the window.

Reconsider the clock used for the window if skew between the hub’s clock and the database’s clock is seen in practice.
