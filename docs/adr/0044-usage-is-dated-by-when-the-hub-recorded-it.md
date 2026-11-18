# Usage is dated by when the hub recorded it

`GET /usage` adds up the Organization's Usage records by UTC day, and dates each record by `recordedAt`, the hub's clock when it wrote the record, not by the job's `endedAt`. A record is written once, in the transaction that records the job's end, so its `recordedAt` never changes: a day that has passed holds the same usage whenever it is read, and so does a month. A day holds the usage the hub recorded that day, which is what someone who compares a day's or a month's figure with what they read before expects to stay put. Records written before the column existed take their `endedAt`.

`endedAt` is the job's own end. For an end a Runner reports, it comes from the Runner's journal, by the Runner's clock, and the report can reach the hub long after the end: a Runner cut off from the hub keeps its jobs running and reports their ends once it reconnects, and a Runner that restarts reports from its journal. Dated by `endedAt`, such an end would add to a day already read, changing a total someone may have acted on, and a clock the hub does not control would decide which day work counts in. The record keeps `endedAt` for what it says about the job.

Days are UTC days, as the API's instants are in UTC, so a day is the same for every caller. Should Usage records grow large enough to be partitioned by month, the partitions would be keyed by the same time: one keyed by `recordedAt` takes no rows once its month has passed, while one keyed by `endedAt` could take a late report's at any time.

## Considered options

- Dating by `endedAt`: a late report changes a past day and month, the Runner's clock decides the day, and a partition by it never closes.
- Dating by the job's `createdAt`: a long job counts on the day it was submitted, and each later end of a resumed job adds to a day long past.

## Consequences

An end the hub learns of late counts on the day it learns of it, so a Runner that reconnects after midnight adds the previous day's work to the new day. A read covers a window of days by an index on `recordedAt`.

## When to reconsider

When callers need usage dated by when the work happened, as to compare it with a model provider's bill, which dates each call, and accept that past days can change: the record keeps `endedAt` for that.
