import type { Clock } from "@symnav/telemetry";

export const DAEMON_IDLE_TIMEOUT_MS = 30 * 60 * 1_000;

export class DaemonLifetime {
  constructor(
    _clock: Clock,
    _idleTimeoutMs: number,
    _onIdle: () => Promise<void>,
  ) {}

  navigationAccepted(): void {
    throw new Error("Daemon navigation deadlines are not implemented");
  }

  queueBecameIdle(): void {
    throw new Error("Daemon active-work expiry is not implemented");
  }

  stop(): void {
    throw new Error("Daemon lifetime stop is not implemented");
  }
}
