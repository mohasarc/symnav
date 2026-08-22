import type { Clock } from "@symnav/telemetry";

export const DAEMON_IDLE_TIMEOUT_MS = 30 * 60 * 1_000;

export class DaemonLifetime {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private deadline: number;
  private navigationActive = false;
  private idleTriggered = false;

  constructor(
    private readonly clock: Clock,
    private readonly idleTimeoutMs: number,
    private readonly onIdle: () => Promise<void>,
  ) {
    this.deadline = this.clock.now() + this.idleTimeoutMs;
    this.schedule();
  }

  navigationAccepted(): void {
    this.navigationActive = true;
    this.deadline = this.clock.now() + this.idleTimeoutMs;
    this.schedule();
  }

  queueBecameIdle(): void {
    this.navigationActive = false;
    if (this.clock.now() >= this.deadline) this.triggerIdle();
  }

  stop(): void {
    throw new Error("Daemon lifetime stop is not implemented");
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    const remainingMs = Math.max(0, this.deadline - this.clock.now());
    this.timer = setTimeout(() => this.deadlineReached(), remainingMs);
    this.timer.unref?.();
  }

  private deadlineReached(): void {
    this.timer = undefined;
    if (this.navigationActive) return;
    this.triggerIdle();
  }

  private triggerIdle(): void {
    if (this.idleTriggered) return;
    this.idleTriggered = true;
    void this.onIdle();
  }
}
