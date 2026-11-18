# Hub and runner are separate deployables from the start

The hub (job submission, the record of jobs and runners, placement) and the runner (job execution) are separate private packages and separate deployables, with a contract between them from the first implementation. The hub runs on Workers or Node/Docker, and Runners are separate Node processes (ADR 0019). They can run in different places, fail independently, and carry different load, so the boundary is drawn now, while it costs little: the hub-runner contract gets designed first, runner code cannot come to depend on hub internals, and local development already matches production. `elflodge stack` runs both in the background on one machine from their images ([ADR 0034](0034-elflodge-stack-runs-in-the-background-through-compose.md)); the CLI otherwise calls an existing hub and does not deploy either service.

## Consequences

The hub also serves the web dashboard, a package of its own whose static build the hub serves from its own origin ([ADR 0043](0043-the-hub-serves-the-dashboard-as-a-static-app-shell.md)).
