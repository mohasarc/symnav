import type { DaemonDiagnosticEvent, DaemonProcessTerminationSignal } from "../transport/protocol.js";
import { DaemonLogger } from "../diagnostics/logger.js";

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
    });
  }

  unhandledRejection(reason: unknown): Promise<void> {
    return this.terminate({
      kind: "process-termination",
      terminationReason: "unhandled-rejection",
      errorName: DaemonLogger.errorName(reason),
    });
  }

  signal(signal: DaemonProcessTerminationSignal): Promise<void> {
    return this.terminate({ kind: "process-termination", terminationReason: "signal", signal });
  }

  private terminate(event: DaemonDiagnosticEvent): Promise<void> {
    if (this.terminationOperation !== undefined) return this.terminationOperation;
    this.terminationOperation = this.recordAndExit(event);
    return this.terminationOperation;
  }

  private async recordAndExit(event: DaemonDiagnosticEvent): Promise<void> {
    try {
      this.recorder.record(event);
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
