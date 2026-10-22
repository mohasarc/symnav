import type { CompletionSpoolManifest } from "./completion-spool.js";
import type { DaemonClock } from "./daemon-clock.js";
import type { BackendRefreshSummary } from "@symnav/core";
import type { DaemonCommandName } from "@symnav/daemon";
import type {
  DaemonDiagnosticEvent,
  DaemonDeliveryOutcome,
  DaemonExecutionOutcome,
  DaemonOperationDiagnostic,
  DaemonShutdownDiagnostic,
  DaemonStartupDiagnostic,
  DaemonWorkerDiagnostic,
  DaemonWorkerPhaseDurations,
} from "./daemon-protocol.js";

export type {
  DaemonDeliveryOutcome,
  DaemonDiagnosticEvent,
  DaemonExecutionOutcome,
  DaemonOperationDiagnostic,
  DaemonShutdownDiagnostic,
  DaemonStartupDiagnostic,
  DaemonWorkerDiagnostic,
  DaemonWorkerPhaseDurations,
} from "./daemon-protocol.js";

export interface DaemonOperationTrace {
  accepted(queueDepth: number, generation: number): void;
  turnStarted(generation: number): void;
  workerCompleted(durations: DaemonWorkerPhaseDurations, refresh: BackendRefreshSummary): void;
  spooled(manifest: CompletionSpoolManifest, durationMs: number): void;
  executionTerminated(outcome: DaemonExecutionOutcome): void;
  clientDisconnected(): void;
  reattached(): void;
  deliveryTerminated(outcome: DaemonDeliveryOutcome): void;
}

interface DaemonDiagnosticRecorder {
  record(event: DaemonDiagnosticEvent): void;
}

interface DaemonOperationResources {
  readonly snapshot: {
    readonly processRssBytes: number;
    readonly peakProcessRssBytes: number;
    readonly peakWorkerHeapUsedBytes?: number;
    readonly workerHeapUsedBytes?: number;
    readonly spoolBytes: number;
  };
}

export class DaemonOperationObserver {
  constructor(
    private readonly logger: DaemonDiagnosticRecorder,
    private readonly clock: DaemonClock,
    private readonly resources?: DaemonOperationResources,
  ) {}

  startup(event: DaemonStartupDiagnostic): void {
    this.logger.record(event);
  }

  worker(event: DaemonWorkerDiagnostic): void {
    this.logger.record(event);
  }

  shutdown(event: DaemonShutdownDiagnostic): void {
    this.logger.record(event);
  }

  reattached(requestId: string): void {
    this.logger.record({ kind: "client-reattached", requestId });
  }

  traceExpired(requestId: string): void {
    this.logger.record({ kind: "operation-trace-expired", requestId });
  }

  deliveryTerminated(requestId: string, outcome: DaemonDeliveryOutcome, deliveryMs: number): void {
    this.logger.record({ kind: "delivery-terminal", requestId, outcome, deliveryMs });
  }

  start(requestId: string, command: DaemonCommandName): DaemonOperationTrace {
    const acceptedAt = this.clock.monotonicNowMs();
    let turnStartedAt: number | undefined;
    let deliveryStartedAt: number | undefined;
    let executionTerminal = false;
    let deliveryTerminal = false;
    return {
      accepted: (queueDepth, generation) => {
        this.logger.record({
          kind: "request-accepted",
          requestId,
          command,
          queueDepth,
          workerGeneration: generation,
        });
      },
      turnStarted: (generation) => {
        turnStartedAt = this.clock.monotonicNowMs();
        this.logger.record({
          kind: "turn-started",
          requestId,
          queueWaitMs: DaemonOperationObserver.elapsed(acceptedAt, turnStartedAt),
          workerGeneration: generation,
        });
      },
      workerCompleted: (durations, refresh) => {
        this.logger.record({ kind: "worker-completed", requestId, ...durations, ...refresh });
      },
      spooled: (manifest, durationMs) => {
        this.logger.record({
          kind: "response-spooled",
          requestId,
          rawBytes: manifest.rawBytes,
          recordCount: manifest.recordCount,
          spoolMs: Math.max(0, durationMs),
        });
      },
      executionTerminated: (outcome) => {
        if (executionTerminal) return;
        executionTerminal = true;
        deliveryStartedAt = this.clock.monotonicNowMs();
        const resources = this.resources?.snapshot;
        this.logger.record({
          kind: "execution-terminal",
          requestId,
          outcome,
          serviceMs: DaemonOperationObserver.elapsed(
            turnStartedAt ?? deliveryStartedAt,
            deliveryStartedAt,
          ),
          ...(resources === undefined
            ? {}
            : {
                processRssBytes: resources.processRssBytes,
                peakProcessRssBytes: resources.peakProcessRssBytes,
                ...(resources.peakWorkerHeapUsedBytes === undefined
                  ? {}
                  : { peakWorkerHeapUsedBytes: resources.peakWorkerHeapUsedBytes }),
                ...(resources.workerHeapUsedBytes === undefined
                  ? {}
                  : { workerHeapUsedBytes: resources.workerHeapUsedBytes }),
                spoolBytes: resources.spoolBytes,
              }),
        });
      },
      clientDisconnected: () => {
        this.logger.record({ kind: "client-disconnected", requestId });
      },
      reattached: () => {
        this.reattached(requestId);
      },
      deliveryTerminated: (outcome) => {
        if (deliveryTerminal) return;
        deliveryTerminal = true;
        const completedAt = this.clock.monotonicNowMs();
        this.deliveryTerminated(
          requestId,
          outcome,
          DaemonOperationObserver.elapsed(deliveryStartedAt ?? completedAt, completedAt),
        );
      },
    };
  }

  private static elapsed(startedAt: number, completedAt: number): number {
    return Math.max(0, completedAt - startedAt);
  }
}
