import type {
  DaemonCommandName,
  DaemonExecutionFailureCode,
  DaemonPolicyValues,
  DaemonSequencedOutputRecord,
} from "@symnav/daemon";
import type {
  AcceptedRequestEntry,
  AcceptedRequestSubscriber,
} from "./accepted-request-ledger.js";
import type { DaemonClock } from "./daemon-clock.js";
import type { DaemonOperationObserver, DaemonOperationTrace } from "./daemon-operation-observer.js";
import type {
  DaemonDiagnosticEvent,
  DaemonIdentityCoordinates,
  DaemonResponse,
  DaemonResultAcknowledgement,
  DaemonResultFetchRequest,
} from "./daemon-protocol.js";
import type {
  CompletionSpool,
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

export class DaemonDeliverySession {
  private readonly operationTraces = new Map<string, DaemonOperationTrace>();

  constructor(private readonly options: DaemonDeliverySessionOptions) {}

  get snapshot(): DaemonDeliverySnapshot {
    return {
      spoolBytes: this.options.spoolStore.usage().rawBytes,
      hasUnacknowledgedCompletions: this.options.journal.hasUnacknowledgedCompletions,
    };
  }

  beginAcceptedTrace(
    requestId: string,
    command: DaemonCommandName,
    queuePosition: number,
    workerGeneration: number,
  ): DaemonOperationTrace {
    const trace = this.options.observer.start(requestId, command);
    this.operationTraces.set(requestId, trace);
    trace.accepted(queuePosition, workerGeneration);
    return trace;
  }

  async createCompletion(requestId: string): Promise<DaemonCompletionWriter> {
    const spool = await this.options.spoolStore.create(requestId);
    return new ObservedDaemonCompletionWriter(
      spool,
      this.operationTraces.get(requestId),
      this.options.clock,
    );
  }
}

class ObservedDaemonCompletionWriter implements DaemonCompletionWriter {
  constructor(
    private readonly spool: CompletionSpool,
    private readonly trace: DaemonOperationTrace | undefined,
    private readonly clock: Pick<DaemonClock, "monotonicNowMs">,
  ) {}

  append(record: DaemonSequencedOutputRecord): Promise<void> {
    return this.spool.append(record);
  }

  async finish(exitCode: number): Promise<CompletionSpoolManifest> {
    const startedAt = this.clock.monotonicNowMs();
    const manifest = await this.spool.finish(exitCode);
    const durationMs = Math.max(0, this.clock.monotonicNowMs() - startedAt);
    this.trace?.spooled(manifest, durationMs);
    return manifest;
  }

  dispose(): Promise<void> {
    return this.spool.dispose();
  }
}
