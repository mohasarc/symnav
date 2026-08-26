import type { BackendRefreshSummary } from "@symnav/core";
import type { CompletionSpoolManifest } from "./completion-spool.js";
import type { DaemonClock } from "./daemon-clock.js";
import type { DaemonCommandName } from "./workspace-request-queue.js";

export interface DaemonWorkerPhaseDurations {
  readonly freshnessMs: number;
  readonly navigationMs: number;
  readonly renderMs: number;
  readonly workerOutputMs: number;
}

export type DaemonExecutionOutcome = "completed" | "failed";
export type DaemonDeliveryOutcome = "delivered" | "disconnected" | "failed";

export type DaemonOperationDiagnostic =
  | {
      readonly kind: "request-accepted";
      readonly requestId: string;
      readonly command: DaemonCommandName;
      readonly queueDepth: number;
      readonly workerGeneration: number;
    }
  | {
      readonly kind: "turn-started";
      readonly requestId: string;
      readonly queueWaitMs: number;
      readonly workerGeneration: number;
    }
  | ({
      readonly kind: "worker-completed";
      readonly requestId: string;
    } & DaemonWorkerPhaseDurations &
      BackendRefreshSummary)
  | {
      readonly kind: "response-spooled";
      readonly requestId: string;
      readonly rawBytes: number;
      readonly recordCount: number;
      readonly spoolMs: number;
    }
  | {
      readonly kind: "execution-terminal";
      readonly requestId: string;
      readonly outcome: DaemonExecutionOutcome;
      readonly serviceMs: number;
      readonly processRssBytes?: number;
      readonly workerHeapUsedBytes?: number;
      readonly spoolBytes?: number;
    }
  | { readonly kind: "client-disconnected"; readonly requestId: string }
  | { readonly kind: "client-reattached"; readonly requestId: string }
  | {
      readonly kind: "delivery-terminal";
      readonly requestId: string;
      readonly outcome: DaemonDeliveryOutcome;
      readonly deliveryMs: number;
    };

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
  record(event: DaemonOperationDiagnostic): void;
}

interface DaemonOperationResources {
  readonly snapshot: {
    readonly processRssBytes: number;
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
        this.logger.record({ kind: "client-reattached", requestId });
      },
      deliveryTerminated: (outcome) => {
        if (deliveryTerminal) return;
        deliveryTerminal = true;
        const completedAt = this.clock.monotonicNowMs();
        this.logger.record({
          kind: "delivery-terminal",
          requestId,
          outcome,
          deliveryMs: DaemonOperationObserver.elapsed(
            deliveryStartedAt ?? completedAt,
            completedAt,
          ),
        });
      },
    };
  }

  private static elapsed(startedAt: number, completedAt: number): number {
    return Math.max(0, completedAt - startedAt);
  }
}
