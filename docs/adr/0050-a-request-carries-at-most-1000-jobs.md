# A request carries at most 1,000 jobs

`POST /batches` and `POST /batches/{id}/jobs` each take up to 1,000 jobs in a body of at most 16 MiB, and commit them together (ADR 0049). A Batch within both limits is created whole or not at all, through the API and through `batches submit`, which packs jobs into requests by both. A request over either limit is refused and makes nothing: more jobs with 400 pointing at `/jobs`, more bytes with 413. A larger Batch is sent in several requests, each committed on its own.

The two limits bound different things. The size bounds what the hub reads whole and parses before it handles a request. The count bounds what the hub does for one request: the rows one transaction inserts, and the answer, which carries each job whole. Bytes of request bound neither, since a job that names its Input files by digest is small in the request. A person meets both limits, and each takes one plain sentence where they submit: a number of jobs and a size.

The count was 100 before, with no reason recorded (elflodge/elflodge#33). Then a job's Input files travelled inline in the request and the hub set no limit on a request's size, so the count was a request's only bound. Input files are now uploaded before the jobs that name them (ADR 0035), and a request's body holds at most 16 MiB, so bytes bound the request and the count is left to bound the hub's work for it.

Measured on a hub run from source against Postgres 18 on loopback, a request of 1,000 jobs with 1 KiB of text each, 1.06 MB answered with 440 KB, took 0.22 s on Node 26, the hub's memory grew by 9 MiB, and other reads made meanwhile were answered in under 0.1 s; on a local workerd it took 0.3 to 0.6 s. An exact repeat, which creates nothing, took 0.13 to 0.24 s. With each of the 1,000 jobs naming a distinct uploaded file, it took 0.23 s on Node and 0.3 to 0.6 s on workerd, and a body one byte under 16 MiB took 0.7 s. Nothing in the hub or its SQL depends on the count: job and file rows enter their statements as one JSON parameter, and lookups bind arrays, so a statement's parameters do not grow with the jobs. These figures support 1,000 and say nothing about more.

## Considered options

- Keep 100, and send a larger Batch in groups: a stop between groups, from a lost connection or a refusal in a later group, leaves a Batch that exists with part of its jobs and is already running them.
- No count, only the 16 MiB: short jobs, or jobs naming their files, would let one request carry hundreds of thousands of jobs, each a row inserted in one transaction and a job in the answer, at sizes nobody measured; and a limit stated only in bytes does not tell a person how many jobs fit.
- A draft Batch sealed across requests: ADR 0049 rules it out until a caller needs atomic submission across requests. A Batch beyond these limits still goes in groups, each committed on its own.

## When to reconsider

Raise the count when a measurement at a larger one, on Node and on Workers, shows the time, memory and answer of a request still small, or when callers need Batches of more than 1,000 jobs to exist whole, which is also when ADR 0049 reconsiders a draft Batch. Lower it if a request at the limit comes near a Workers isolate's memory or holds up other requests.
