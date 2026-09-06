# Daemon policy

`DaemonPolicy` is one immutable, complete snapshot. The CLI creates it from system memory and passes the same serialized values through daemon process and worker boundaries. Tests may replace individual values through `DaemonPolicyTestFactory`; users have no flag, environment variable, or configuration file for these values.

| Policy path or recipe | Default or derivation | Applies to | Reason | Behavior oracle |
| --- | --- | --- | --- | --- |
| `transport.singleResponseTimeoutMs` | 250 ms | Ordinary lifecycle and execution-status exchanges | Bound one-response local socket waits | Transport timeout characterization |
| `transport.statusResponseTimeoutMs` | 100 ms | Status observer lifecycle exchange | Keep status aggregation responsive independently of routing | Status timeout characterization |
| `transport.executionAdmissionTimeoutMs` | 5 s | Execute submission until acceptance | Bound admission without timing accepted completion | Long-command transport characterization |
| `transport.maximumJsonPayloadBytes` | 8 MiB | Ordinary JSON control frames | Bound decoded control input | Transport frame-cap tests |
| `transport.maximumExecutionControlPayloadBytes` | 256 KiB | Execution transfer control frames | Keep binary-transfer control bounded separately | Transfer codec tests |
| `startup.coordinationGraceMs` | 15 s | Startup ownership and missing-owner observation | Preserve election recovery grace | Registry/startup suites |
| `startup.heartbeatIntervalMs` | 100 ms | Startup-owner heartbeat | Maintain live ownership while warming | Startup heartbeat tests |
| `startup.authorizationPollIntervalMs` | 10 ms | Process authorization wait | Preserve the distinct fast authorization cadence | Authorization cadence characterization |
| `startup.observationPollIntervalMs` | 20 ms | Launcher readiness observation | Preserve current readiness polling cadence | Startup observation tests |
| `startup.previousInstanceTerminationTimeoutMs` | 5 min | Replacement of a previous instance | Allow controlled termination before new ownership proceeds | Startup replacement tests |
| `startup.childFailureRetryLimit` | 1 retry | Explicit startup child failure | Preserve one fresh launch after a failed child | Startup retry tests |
| `shutdown.idleTimeoutMs` | 30 min | Warm daemon idle lifetime | Release retained resources after inactivity | Lifetime tests |
| `shutdown.stopTimeoutMs` | 5 s | User-requested stop | Bound graceful stop and forced escalation together | Controller stop tests |
| `shutdown.forcedTerminationReserveMaximumMs` | 500 ms | Stop escalation reserve | Leave bounded time for authenticated force termination | Controller deadline tests |
| `recipe.forcedTerminationReserve` | `min(forcedTerminationReserveMaximumMs, floor(stopTimeoutMs / 2))` | Effective stop escalation reserve | Preserve small overridden stop windows | Controller deadline tests |
| `shutdown.controllerPollIntervalMs` | 20 ms | Controller process/registry observation | Preserve control-plane polling cadence | Controller polling tests |
| `shutdown.processSignalExitTimeoutMs` | 500 ms after SIGTERM and 500 ms after SIGKILL | Direct process termination | Give each signal a bounded exit interval | Process terminator tests |
| `shutdown.processExitPollIntervalMs` | 20 ms | Direct process termination | Preserve process-exit polling cadence independently | Process terminator tests |
| `shutdown.resourceDrainAcknowledgementGraceMs` | 250 ms | Completion acknowledgement during drain | Permit an attached client to acknowledge before cleanup | Shutdown acknowledgement tests |
| `shutdown.resourceDrainAcknowledgementPollIntervalMs` | 5 ms | Completion acknowledgement during drain | Preserve the distinct fast acknowledgement cadence | Acknowledgement cadence characterization |
| `delivery.postAcceptanceExecutionReattachmentLimit` | 1 reattachment | Authenticated close after acceptance | Recover the accepted request without local replay | Reattachment tests |
| `delivery.resultTransferResumeLimitPerExecutionAttempt` | 1 fetch resume per execute attempt | Interrupted manifest transfer | Resume one transfer independently for each execute attempt | Two-scope resume tests |
| `output.maximumChunkRawBytes` | 64 KiB | Worker and result chunks | Bound one raw output record | Chunk codec and spool tests |
| `output.inlineRawBytes` | 256 KiB | Inline result storage | Avoid files for small results | Spool threshold tests |
| `output.maximumResultRawBytes` | 256 MiB | One completed result | Bound retained output for one request | Result-cap tests |
| `output.maximumAggregateSpoolRawBytes` | 512 MiB | All retained completions for one daemon | Bound aggregate spool pressure | Aggregate-cap tests |
| `recipe.effectiveMemorySelection` | Use constrained bytes only when positive and smaller than total bytes; preserve selected raw bytes | Memory derivation input | Respect real lower constraints without rounding identity | Policy derivation table |
| `resources.effectiveMemoryBytes` | Selected raw effective bytes | Resource reports and derived thresholds | Preserve non-MiB-aligned system information exactly | Policy derivation table |
| `recipe.effectiveMemoryMiB` | `max(1, floor(effectiveMemoryBytes / MiB))` | Memory threshold derivation | Give sub-MiB inputs a stable minimum | Policy boundary tests |
| `recipe.hardProcessRss` | `clamp(floor(effectiveMemoryMiB / 2), 256, 8192) * MiB` | Hard daemon RSS limit | Reserve memory for the host while bounding small and large systems | Policy boundary tests |
| `resources.hardProcessRssBytes` | Hard-process-RSS recipe | Process replacement and worker launch | Trigger controlled replacement before OOM | Resource supervision tests |
| `resources.softProcessRssBytes` | `floor(hardProcessRssMiB * 0.8) * MiB` | Transient resource shedding | Shed before hard replacement | Resource hysteresis tests |
| `resources.resumeProcessRssBytes` | `floor(hardProcessRssMiB * 0.7) * MiB` | Admission resumption | Require lower RSS before resuming work | Resource hysteresis tests |
| `recipe.workerOldGeneration` | `clamp(floor(effectiveMemoryMiB / 4), 128, 4096)` MiB | Worker V8 old generation | Bound worker heap within process budget | Worker launch tests |
| `resources.workerMaxOldGenerationSizeMiB` | Worker-old-generation recipe | Worker resource limits | Pass the derived V8 limit unchanged | Process/worker snapshot test |
| `resources.supervisionIntervalMs` | 250 ms | Process RSS and spool sampling | Detect sustained pressure without per-operation overhead | Resource cadence tests |
| `resources.replacementWindowMs` | 10 min | Replacement circuit | Count only recent replacements | Replacement-window tests |
| `resources.replacementLimit` | 2 replacements; third drains | Replacement circuit | Stop persistent replacement churn | Persistent-pressure tests |
| `resources.workerHeapSampleIntervalMs` | 25 ms | Active worker heap high-water sampling | Observe short-lived heap peaks | Worker cadence characterization |
| `diagnostics.logRotateBytes` | 10 MiB | Diagnostic log rotation | Bound active diagnostic file size | Logger rotation tests |
| `diagnostics.logBackupCount` | 4 backups plus active log | Diagnostic log rotation | Retain a bounded diagnostic history | Logger backup tests |
| `diagnostics.maximumQueuedEvents` | 1,024 | Pending diagnostic writes | Bound memory when storage is slow | Logger queue tests |
| `diagnostics.disconnectedTraceRetentionMs` | 5 min | Disconnected operation traces | Retain reconnect evidence without changing result retention | Trace expiry tests |
| `diagnostics.maximumDisconnectedTraces` | 1,024 with effective minimum 1 | Disconnected operation traces | Bound diagnostic-only retention | Trace capacity tests |

## Intentional absences

| Deadline | Value | Reason |
| --- | --- | --- |
| healthy startup | None | Progressing warm-up has no project-size deadline. |
| startup silence | None | Silence handling is deferred to the daemon follow-up contract. |
| post-accept completion | None | Accepted work is not replayed or failed because it runs long. |
| worker output acknowledgement | None | Backpressure waits for durable consumption without a timer. |
| unacknowledged result | None | Retention eviction is deferred to the daemon follow-up contract. |

## Migration access

Policy serialization is package-internal. Process and worker entries exchange complete snapshots through the internal codec without widening the host-facing `DaemonPolicy` surface.

Policy test factories remain package-local test helpers and are not exported.
