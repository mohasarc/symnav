import { performance } from "node:perf_hooks";

export interface DaemonClock {
  wallNowMs(): number;
  monotonicNowMs(): number;
}

interface DaemonClockSources {
  readonly wallNowMs: () => number;
  readonly monotonicNowMs: () => number;
}

export class NodeDaemonClock implements DaemonClock {
  constructor(
    private readonly sources: DaemonClockSources = {
      wallNowMs: Date.now,
      monotonicNowMs: () => performance.now(),
    },
  ) {}

  wallNowMs(): number {
    return this.sources.wallNowMs();
  }

  monotonicNowMs(): number {
    return this.sources.monotonicNowMs();
  }
}
