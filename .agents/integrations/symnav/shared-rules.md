# Agent runtime rules

This environment can be slow. For every shell command, wait at least 5 minutes before treating silence as a stuck process.

When a tool supports `timeout_ms` or `yield_time_ms`, pass at least `300000`. Continue polling long-running commands until 5 minutes have elapsed. An early empty poll is not the final result.
