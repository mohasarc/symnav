import type { DaemonFailure } from "../daemon-failure.js";
import { DaemonFailureRecorder } from "../diagnostics/failure-recorder.js";
import type {
  DaemonDiagnosticEvent,
  DaemonProcessTerminationSignal,
} from "../transport/protocol.js";
import { DaemonLogger } from "../diagnostics/logger.js";
import { NodeDaemonClock, type DaemonClock } from "../lifecycle/daemon-clock.js";

interface DaemonTerminationRecorder {
  record(event: DaemonDiagnosticEvent): void;
  flush(): Promise<void>;
}

export class DaemonProcessTerminationObserver {
  private terminationOperation: Promise<void> | undefined;

  constructor(
    private readonly recorder: DaemonTerminationRecorder,
    private readonly cleanup: () => void,
    private readonly exit: (code: number) => never = (code) => process.exit(code),
    private readonly recordFailure?: (failure: DaemonFailure) => Promise<void>,
    private readonly clock: Pick<DaemonClock, "wallNowMs"> = new NodeDaemonClock(),
  ) {}

  install(): void {
    process.on("uncaughtException", (error, origin) => {
      void this.uncaughtException(error, origin);
    });
    process.on("unhandledRejection", (reason) => {
      void this.unhandledRejection(reason);
    });
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
      process.on(signal, () => void this.signal(signal));
    }
  }

  uncaughtException(error: unknown, origin: string): Promise<void> {
    return this.terminate({
      kind: "process-termination",
      terminationReason:
        origin === "unhandledRejection" ? "unhandled-rejection" : "uncaught-exception",
      errorName: DaemonLogger.errorName(error),
      failure: DaemonFailureRecorder.failure(
        this.clock.wallNowMs(),
        "process spawn",
        "process-terminated",
        error,
      ),
    });
  }

  unhandledRejection(reason: unknown): Promise<void> {
    return this.terminate({
      kind: "process-termination",
      terminationReason: "unhandled-rejection",
      errorName: DaemonLogger.errorName(reason),
      failure: DaemonFailureRecorder.failure(
        this.clock.wallNowMs(),
        "process spawn",
        "process-terminated",
        reason,
      ),
    });
  }

  signal(signal: DaemonProcessTerminationSignal): Promise<void> {
    return this.terminate({
      kind: "process-termination",
      terminationReason: "signal",
      signal,
      failure: DaemonFailureRecorder.failure(
        this.clock.wallNowMs(),
        "process spawn",
        "process-terminated",
      ),
    });
  }

  private terminate(event: DaemonDiagnosticEvent): Promise<void> {
    if (this.terminationOperation !== undefined) return this.terminationOperation;
    this.terminationOperation = this.recordAndExit(event);
    return this.terminationOperation;
  }

  private async recordAndExit(event: DaemonDiagnosticEvent): Promise<void> {
    try {
      this.recorder.record(event);
      if (event.kind === "process-termination" && event.failure !== undefined)
        await this.recordFailure?.(event.failure);
      await this.recorder.flush();
    } finally {
      try {
        this.cleanup();
      } finally {
        this.exit(1);
      }
    }
  }
}
