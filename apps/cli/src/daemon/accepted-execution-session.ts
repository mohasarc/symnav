import { DaemonExecutionFailures, type AcceptedRequestCompatibility } from "@symnav/daemon";
import type {
  AcceptedExecutionAdmission,
  AcceptedExecutionSessionOptions,
  AcceptedExecutionSnapshot,
  AuthenticatedDaemonExecuteRequest,
} from "./accepted-execution-session-contracts.js";
import { CompletionSpoolCapacityError } from "./completion-spool.js";
import type { DaemonCompletionWriter } from "./daemon-delivery-session.js";
import { DaemonLogger } from "./daemon-logger.js";
import { DaemonNavigationWorkerExitedError } from "./daemon-navigation-worker.js";
import type { DaemonOperationTrace } from "./daemon-operation-observer.js";
import type {
  DaemonExecuteRequest,
  DaemonExecutionStatus,
  DaemonWorkerReplacementCause,
} from "./daemon-protocol.js";

export class AcceptedExecutionSession {
  private lastNavigationAt: number | undefined;
  private lastCompletedMonotonicAt: number | undefined;
  private readonly resourceInterruptedRequests = new Set<string>();

  constructor(private readonly options: AcceptedExecutionSessionOptions) {}

  get snapshot(): AcceptedExecutionSnapshot {
    return Object.freeze({
      queue: this.options.queue.snapshot,
      ...(this.lastNavigationAt === undefined ? {} : { lastNavigationAt: this.lastNavigationAt }),
      ...(this.lastCompletedMonotonicAt === undefined
        ? {}
        : { lastCompletedMonotonicAt: this.lastCompletedMonotonicAt }),
    });
  }

  compatibilityFor(request: DaemonExecuteRequest): AcceptedRequestCompatibility {
    return this.options.ledger.compatibilityFor(
      request.requestId,
      request.commandName,
      request.request,
    );
  }

  accept(request: AuthenticatedDaemonExecuteRequest): AcceptedExecutionAdmission {
    const existing = this.options.ledger.entryFor(request.requestId);
    const entry = this.options.ledger.accept(
      request.requestId,
      request.commandName,
      request.request,
    );
    const acceptance = Object.freeze({
      requestId: request.requestId,
      acceptedAt: entry.acceptedAt,
      queuePosition: entry.queuePosition,
    });
    if (existing !== undefined) {
      return Object.freeze({ newlyAccepted: false, entry, acceptance });
    }
    this.lastNavigationAt = this.options.clock.wallNowMs();
    this.options.lifetime.navigationAccepted();
    const trace = this.options.delivery.beginAcceptedTrace(
      request.requestId,
      request.commandName,
      entry.queuePosition,
      this.options.resourceSupervisor.snapshot.generation,
    );
    void this.executeAccepted(request, trace);
    return Object.freeze({ newlyAccepted: true, entry, acceptance });
  }

  status(requestId: string): DaemonExecutionStatus {
    return this.options.ledger.status(requestId);
  }

  markActiveResourceInterrupted(cause: DaemonWorkerReplacementCause): void {
    if (cause === "worker-exit") return;
    const activeRequest = this.options.queue.snapshot.active;
    if (activeRequest !== undefined) this.resourceInterruptedRequests.add(activeRequest.requestId);
  }

  scheduleAtTurnBoundary(operation: () => Promise<void>): Promise<void> {
    return this.options.queue.scheduleAtTurnBoundary(operation);
  }

  drain(): Promise<void> {
    return this.options.queue.drain();
  }

  close(): void {
    this.options.queue.close();
  }

  private async executeAccepted(
    request: AuthenticatedDaemonExecuteRequest,
    trace: DaemonOperationTrace,
  ): Promise<void> {
    let completion: DaemonCompletionWriter | undefined;
    try {
      await this.options.queue.enqueue(
        {
          requestId: request.requestId,
          command: request.commandName,
          acceptedAt: this.options.clock.monotonicNowMs(),
        },
        async () => {
          trace.turnStarted(this.options.resourceSupervisor.snapshot.generation);
          try {
            completion = await this.options.delivery.createCompletion(request.requestId);
            this.options.ledger.markRunning(request.requestId, this.options.clock.wallNowMs());
            const response = await this.options.worker.execute(
              request.requestId,
              { commandName: request.commandName, request: request.request },
              completion,
            );
            this.options.resourceSupervisor.workerHeapReported(
              response.generation,
              response.resources.workerHeapUsedBytes,
              response.resources.workerHeapLimitBytes,
              response.resources.peakWorkerHeapUsedBytes,
            );
            trace.workerCompleted(
              {
                freshnessMs: response.durations.freshnessMs,
                navigationMs: response.durations.navigationMs,
                renderMs: response.durations.renderMs,
                workerOutputMs: response.durations.outputMs,
              },
              response.refresh,
            );
            await completion.finish(response.result.exitCode);
            this.lastCompletedMonotonicAt = this.options.clock.monotonicNowMs();
            const workspaceExists = await this.options.processLifecycle.workspaceExists();
            trace.executionTerminated("completed");
            this.options.ledger.complete(
              request.requestId,
              request.requestId,
              this.options.clock.wallNowMs(),
            );
            await this.options.delivery.trackedCompletion(request.requestId);
            if (!workspaceExists) {
              await this.options.processLifecycle.workspaceDeletedAfterDelivery();
            }
          } finally {
            this.scheduleTurnCompleteResourceSample();
          }
        },
      );
    } catch (error) {
      trace.executionTerminated("failed");
      this.recordFailure("request", "internal", error);
      const shutdown = this.options.processLifecycle.shutdownSnapshot();
      const code = DaemonExecutionFailures.classify({
        resourceInterrupted: this.resourceInterruptedRequests.delete(request.requestId),
        responseCapacityExceeded: error instanceof CompletionSpoolCapacityError,
        workerExited: error instanceof DaemonNavigationWorkerExitedError,
        ...(shutdown.failureCode === undefined
          ? {}
          : { shutdownFailureCode: shutdown.failureCode }),
        shutdownStarted: shutdown.started,
      });
      await completion?.dispose().catch((cleanupError) => {
        this.recordFailure("completion-cleanup", "internal", cleanupError);
      });
      this.options.ledger.fail(request.requestId, code, this.options.clock.wallNowMs());
    } finally {
      if (this.options.queue.isIdle) this.options.lifetime.queueBecameIdle();
    }
  }

  private scheduleTurnCompleteResourceSample(): void {
    void this.options.queue
      .scheduleAtTurnBoundary(() => this.options.resourceSupervisor.sampleAtTurnBoundary())
      .catch((error) => {
        this.recordFailure("resource-sample", "operation-failed", error);
      })
      .finally(() => {
        if (this.options.queue.isIdle) this.options.lifetime.queueBecameIdle();
      });
  }

  private recordFailure(
    operation: "request" | "completion-cleanup" | "resource-sample",
    failureCode: "internal" | "operation-failed",
    error: unknown,
  ): void {
    this.options.diagnostics.record({
      kind: "failure",
      operation,
      failureCode,
      errorName: DaemonLogger.errorName(error),
    });
  }
}
