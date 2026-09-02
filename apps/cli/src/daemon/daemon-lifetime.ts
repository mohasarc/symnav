import type { Clock } from "@symnav/telemetry";

export const DAEMON_IDLE_TIMEOUT_MS = 30 * 60 * 1_000;

export class DaemonLifetime {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private deadline: number;
  private navigationActive = false;
  private stopped = false;
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
    if (this.stopped) return;
    this.navigationActive = true;
    this.deadline = this.clock.now() + this.idleTimeoutMs;
    this.schedule();
  }

  queueBecameIdle(): void {
    if (this.stopped) return;
    this.navigationActive = false;
    if (this.clock.now() >= this.deadline) this.triggerIdle();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    const remainingMs = Math.max(0, this.deadline - this.clock.now());
    this.timer = setTimeout(() => this.deadlineReached(), remainingMs);
    this.timer.unref?.();
  }

  private deadlineReached(): void {
    this.timer = undefined;
    if (this.stopped || this.navigationActive) return;
    this.triggerIdle();
  }

  private triggerIdle(): void {
    if (this.idleTriggered) return;
    this.idleTriggered = true;
    void this.onIdle();
  }
}
