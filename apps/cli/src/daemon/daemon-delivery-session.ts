import type {
  DaemonExecutionFailureCode,
  DaemonPolicyValues,
  DaemonSequencedOutputRecord,
} from "@symnav/daemon";
import type {
  AcceptedRequestEntry,
  AcceptedRequestSubscriber,
} from "./accepted-request-ledger.js";
import type { DaemonClock } from "./daemon-clock.js";
import type { DaemonOperationObserver } from "./daemon-operation-observer.js";
import type {
  DaemonDiagnosticEvent,
  DaemonIdentityCoordinates,
  DaemonResponse,
  DaemonResultAcknowledgement,
  DaemonResultFetchRequest,
} from "./daemon-protocol.js";
import type {
  CompletionSpoolManifest,
  DaemonCompletionSpoolStore,
} from "./completion-spool.js";

export interface DaemonDiagnosticRecorder {
  record(event: DaemonDiagnosticEvent): void;
}

export interface DaemonCompletionWriter {
  append(record: DaemonSequencedOutputRecord): Promise<void>;
  finish(exitCode: number): Promise<CompletionSpoolManifest>;
  dispose(): Promise<void>;
}

export interface DaemonDeliverySnapshot {
  readonly spoolBytes: number;
  readonly hasUnacknowledgedCompletions: boolean;
}

export interface DaemonDeliveryAttachment {
  readonly requestId: string;
  readonly acceptedAt: number;
  readonly queuePosition: number;
}

export interface AcceptedExecutionJournal {
  readonly hasUnacknowledgedCompletions: boolean;
  entryFor(requestId: string): AcceptedRequestEntry | undefined;
  subscribe(requestId: string, subscriber: AcceptedRequestSubscriber): () => void;
  invalidateCompletion(
    requestId: string,
    code: DaemonExecutionFailureCode,
    completedAt: number,
  ): void;
  acknowledge(requestId: string): void;
  terminateDelivery(requestId: string): boolean;
  isDeliveryTerminated(requestId: string): boolean;
}

export type AuthenticatedDaemonResultFetchRequest = DaemonResultFetchRequest;
export type AuthenticatedDaemonResultAcknowledgement = DaemonResultAcknowledgement;
export type DaemonResultAcknowledged = Extract<DaemonResponse, { readonly kind: "result-acknowledged" }>;

export interface DaemonDeliverySessionOptions {
  readonly coordinates: Pick<DaemonIdentityCoordinates, "instanceId" | "processToken">;
  readonly journal: AcceptedExecutionJournal;
  readonly spoolStore: DaemonCompletionSpoolStore;
  readonly observer: DaemonOperationObserver;
  readonly diagnostics: DaemonDiagnosticRecorder;
  readonly clock: DaemonClock;
  readonly policy: Pick<DaemonPolicyValues, "delivery" | "diagnostics" | "shutdown">;
}
