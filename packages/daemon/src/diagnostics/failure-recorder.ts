import { randomUUID } from "node:crypto";
import type {
  DaemonFailure,
  DaemonFailureEvent,
  DaemonFailurePhase,
  DaemonFailureReason,
} from "../daemon-failure.js";
import type { DaemonClock } from "../lifecycle/daemon-clock.js";
import type { DaemonStateWriteFailureObserver } from "../state-write-failure.js";
import { DaemonStateWriteErrors } from "../state-write-errors.js";
import type { DaemonFailureJournal } from "./failure-journal.js";

export class DaemonFailureRecorder {
  public constructor(
    private readonly journal: Pick<DaemonFailureJournal, "record">,
    private readonly workspaceRoot: string,
    private readonly clock: Pick<DaemonClock, "wallNowMs">,
    private readonly stateWriteFailed?: DaemonStateWriteFailureObserver,
  ) {}

  public async record(
    kind: DaemonFailureEvent["kind"],
    phase: DaemonFailurePhase,
    reason: DaemonFailureReason,
    error?: unknown,
    instanceId?: string,
    requestId?: string,
  ): Promise<void> {
    try {
      await this.journal.record({
        schemaVersion: 1,
        eventId: `${kind}:${kind === "fallback" ? (requestId ?? randomUUID()) : (instanceId ?? randomUUID())}`,
        workspaceRoot: this.workspaceRoot,
        ...(instanceId === undefined ? {} : { instanceId }),
        ...(requestId === undefined ? {} : { requestId }),
        kind,
        failure: DaemonFailureRecorder.failure(this.clock.wallNowMs(), phase, reason, error),
      });
    } catch (writeError) {
      const failure = DaemonStateWriteErrors.from(writeError);
      if (failure !== undefined) this.stateWriteFailed?.(failure);
    }
  }

  public static failure(
    timestamp: number,
    phase: DaemonFailurePhase,
    reason: DaemonFailureReason,
    error?: unknown,
  ): DaemonFailure {
    const osCode = this.osCode(error);
    return {
      phase,
      reason:
        phase === "endpoint connect" && osCode === "ECONNRESET"
          ? "daemon-connection-reset"
          : reason,
      timestamp,
      ...(osCode === undefined ? {} : { osCode }),
    };
  }

  public static osCode(error: unknown): string | undefined {
    const seen = new Set<unknown>();
    let current = error;
    while (typeof current === "object" && current !== null && !seen.has(current)) {
      seen.add(current);
      if (
        "code" in current &&
        typeof current.code === "string" &&
        /^(?:E[A-Z0-9_]{1,63}|ERR_[A-Z0-9_]{1,60})$/u.test(current.code)
      )
        return current.code;
      current = "cause" in current ? current.cause : undefined;
    }
    return undefined;
  }
}
