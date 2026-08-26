import type { DaemonDiagnosticEvent, DaemonProcessTerminationSignal } from "./daemon-protocol.js";

interface DaemonTerminationRecorder {
  record(event: DaemonDiagnosticEvent): void;
  flush(): Promise<void>;
}

export class DaemonProcessTerminationObserver {
  constructor(
    private readonly recorder: DaemonTerminationRecorder,
    private readonly cleanup: () => void,
    private readonly exit: (code: number) => never = (code) => process.exit(code),
  ) {}

  install(): void {
    throw new Error("Daemon process termination observation is not implemented");
  }

  uncaughtException(_error: unknown, _origin: string): Promise<void> {
    return Promise.reject(new Error("Daemon process termination observation is not implemented"));
  }

  unhandledRejection(_reason: unknown): Promise<void> {
    return Promise.reject(new Error("Daemon process termination observation is not implemented"));
  }

  signal(_signal: DaemonProcessTerminationSignal): Promise<void> {
    return Promise.reject(new Error("Daemon process termination observation is not implemented"));
  }
}
