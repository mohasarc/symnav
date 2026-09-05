import type { AcceptedRequestEntry, AcceptedRequestLedger } from "./accepted-request-ledger.js";
import type { DaemonClock } from "../lifecycle/daemon-clock.js";
import type {
  DaemonCompletionWriter,
  DaemonDiagnosticRecorder,
} from "../delivery/delivery-session.js";
import type { DaemonOperationTrace } from "../diagnostics/operation-observer.js";
import type { DaemonExecuteRequest } from "../transport/protocol.js";
import type { DaemonResourceSupervisor } from "../resources/resource-supervisor.js";
import type { DaemonWorkerGenerationManager } from "../worker/worker-generation-manager.js";
import type {
  WorkspaceRequestQueue,
  WorkspaceRequestQueueSnapshot,
} from "./request-queue.js";

export type AuthenticatedDaemonExecuteRequest = DaemonExecuteRequest;

export interface AcceptedExecutionAdmission {
  readonly newlyAccepted: boolean;
  readonly entry: AcceptedRequestEntry;
  readonly acceptance: {
    readonly requestId: string;
    readonly acceptedAt: number;
    readonly queuePosition: number;
  };
}

export interface AcceptedExecutionSnapshot {
  readonly queue: WorkspaceRequestQueueSnapshot;
  readonly lastNavigationAt?: number;
  readonly lastCompletedMonotonicAt?: number;
}

export interface AcceptedExecutionDelivery {
  beginAcceptedTrace(
    requestId: string,
    command: DaemonExecuteRequest["commandName"],
    queuePosition: number,
    workerGeneration: number,
  ): DaemonOperationTrace;
  createCompletion(requestId: string): Promise<DaemonCompletionWriter>;
  trackedCompletion(requestId: string): Promise<void> | undefined;
}

export interface AcceptedExecutionLifetime {
  navigationAccepted(): void;
  queueBecameIdle(): void;
}

export interface AcceptedExecutionProcessLifecycle {
  shutdownSnapshot(): {
    readonly started: boolean;
    readonly failureCode?: "stopping" | "controlled-resource";
  };
  workspaceExists(): Promise<boolean>;
  workspaceDeletedAfterDelivery(): Promise<void>;
}

export interface AcceptedExecutionSessionOptions {
  readonly ledger: AcceptedRequestLedger;
  readonly queue: WorkspaceRequestQueue;
  readonly worker: DaemonWorkerGenerationManager;
  readonly delivery: AcceptedExecutionDelivery;
  readonly resourceSupervisor: DaemonResourceSupervisor;
  readonly processLifecycle: AcceptedExecutionProcessLifecycle;
  readonly lifetime: AcceptedExecutionLifetime;
  readonly diagnostics: DaemonDiagnosticRecorder;
  readonly clock: DaemonClock;
}
