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
  DaemonDeliveryOutcome,
  DaemonExecutionServerFrame,
  DaemonIdentityCoordinates,
  DaemonResponse,
  DaemonResultAcknowledgement,
  DaemonResultFetchRequest,
  DaemonServerMessage,
} from "./daemon-protocol.js";
import {
  CompletionSpoolReadError,
  type CompletionSpool,
  type CompletionSpoolManifest,
  type DaemonCompletionSpoolStore,
} from "./completion-spool.js";
import { DaemonLogger } from "./daemon-logger.js";
import type { DaemonServerSend } from "./daemon-transport.js";

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
  private readonly completionDeliveries = new Map<string, Promise<void>>();
  private readonly operationTraces = new Map<string, DaemonOperationTrace>();
  private readonly operationTraceExpirations = new Map<string, NodeJS.Timeout>();
  private readonly operationTraceConnections = new Map<string, number>();

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

  async attach(attachment: DaemonDeliveryAttachment, send: DaemonServerSend): Promise<void> {
    const entry = this.options.journal.entryFor(attachment.requestId);
    if (entry === undefined) throw new Error("Accepted request result is missing");
    const traceWasDisconnected = this.traceWasDisconnected(attachment.requestId);
    const disconnectTraceConnection = this.attachOperationTraceConnection(
      attachment.requestId,
      send,
    );
    if (traceWasDisconnected) this.reattachOperationTrace(attachment.requestId);
    try {
      await this.deliver(send, {
        kind: "accepted",
        ...this.options.coordinates,
        ...attachment,
      });
      if (entry.state.state === "completed") {
        await this.deliverStoredCompletion(attachment.requestId, send);
        return;
      }
      if (entry.state.state === "failed") {
        await this.deliver(send, this.failedFrame(attachment.requestId, entry.state.code));
        this.completeOperationTrace(attachment.requestId, "delivered");
        return;
      }
    } catch (error) {
      disconnectTraceConnection();
      throw error;
    }
    let unsubscribe: (() => void) | undefined;
    unsubscribe = this.options.journal.subscribe(attachment.requestId, (updated) => {
      if (updated.state.state === "completed") {
        this.trackCompletionDelivery(attachment.requestId, send, disconnectTraceConnection);
        unsubscribe?.();
      } else if (updated.state.state === "failed") {
        void this.deliver(send, this.failedFrame(attachment.requestId, updated.state.code))
          .then(() => this.completeOperationTrace(attachment.requestId, "delivered"))
          .catch((error) =>
            this.recordDeliveryFailure(attachment.requestId, error, disconnectTraceConnection),
          );
        unsubscribe?.();
      }
    });
  }

  private deliver(send: DaemonServerSend, frame: DaemonServerMessage): Promise<void> {
    return send(frame);
  }

  private async deliverStoredCompletion(
    requestId: string,
    send: DaemonServerSend,
    offset = 0,
  ): Promise<void> {
    const spool = await this.options.spoolStore.open(requestId);
    if (spool === undefined) throw new Error("Accepted request result is missing");
    try {
      await this.deliverCompletion(requestId, spool, offset, send);
    } catch (error) {
      if (!(error instanceof CompletionSpoolReadError)) throw error;
      this.recordFailure("completion-delivery", error);
      await spool.dispose().catch((cleanupError) => {
        this.recordFailure("completion-cleanup", cleanupError);
      });
      this.options.journal.invalidateCompletion(
        requestId,
        "internal",
        this.options.clock.wallNowMs(),
      );
      await this.deliver(send, this.failedFrame(requestId, "internal"));
      this.completeOperationTrace(requestId, "failed");
    }
  }

  private trackCompletionDelivery(
    requestId: string,
    send: DaemonServerSend,
    disconnectTraceConnection: () => void,
  ): void {
    const delivery = this.deliverStoredCompletion(requestId, send).catch((error) =>
      this.recordDeliveryFailure(requestId, error, disconnectTraceConnection),
    );
    this.completionDeliveries.set(requestId, delivery);
    void delivery.finally(() => {
      if (this.completionDeliveries.get(requestId) === delivery) {
        this.completionDeliveries.delete(requestId);
      }
    });
  }

  private async deliverCompletion(
    requestId: string,
    spool: CompletionSpool,
    offset: number,
    send: DaemonServerSend,
  ): Promise<void> {
    const completedManifest = spool.completedManifest;
    if (completedManifest === undefined) throw new Error("Completion manifest is missing");
    await this.deliver(send, {
      kind: "result-manifest",
      ...this.options.coordinates,
      requestId,
      manifest: completedManifest,
    });
    for await (const record of spool.read(offset)) {
      await this.deliver(send, {
        transferId: completedManifest.transferId,
        requestId,
        offset: record.sequence,
        sequence: record.sequence,
        stream: record.stream,
        bytes: record.bytes,
      });
    }
    await this.deliver(send, {
      kind: "result-end",
      ...this.options.coordinates,
      requestId,
      transferId: completedManifest.transferId,
      rawBytes: completedManifest.rawBytes,
      recordCount: completedManifest.recordCount,
      sha256: completedManifest.sha256,
    });
    this.terminateOperationDelivery(requestId, "delivered");
  }

  private failedFrame(
    requestId: string,
    code: DaemonExecutionFailureCode,
  ): DaemonExecutionServerFrame {
    return {
      kind: "execution-failed",
      ...this.options.coordinates,
      requestId,
      code,
    };
  }

  private recordDeliveryFailure(
    requestId: string,
    error: unknown,
    disconnectTraceConnection: () => void,
  ): void {
    disconnectTraceConnection();
    this.recordFailure("completion-delivery", error);
  }

  private recordFailure(
    operation: "completion-delivery" | "completion-cleanup",
    error: unknown,
  ): void {
    this.options.diagnostics.record({
      kind: "failure",
      operation,
      failureCode: "internal",
      errorName: DaemonLogger.errorName(error),
    });
  }

  private completeOperationTrace(requestId: string, outcome: DaemonDeliveryOutcome): void {
    const expiration = this.operationTraceExpirations.get(requestId);
    if (expiration !== undefined) clearTimeout(expiration);
    this.operationTraceExpirations.delete(requestId);
    this.operationTraceConnections.delete(requestId);
    this.terminateOperationDelivery(requestId, outcome);
    this.operationTraces.delete(requestId);
  }

  private terminateOperationDelivery(requestId: string, outcome: DaemonDeliveryOutcome): void {
    if (!this.options.journal.terminateDelivery(requestId)) return;
    const trace = this.operationTraces.get(requestId);
    if (trace === undefined) this.options.observer.deliveryTerminated(requestId, outcome, 0);
    else trace.deliveryTerminated(outcome);
  }

  private disconnectOperationTrace(requestId: string): void {
    if (this.operationTraceExpirations.has(requestId)) return;
    const trace = this.operationTraces.get(requestId);
    if (trace === undefined) return;
    trace.clientDisconnected();
    const expiration = setTimeout(
      () => this.expireOperationTrace(requestId),
      this.options.policy.diagnostics.disconnectedTraceRetentionMs,
    );
    expiration.unref();
    this.operationTraceExpirations.set(requestId, expiration);
    this.enforceOperationTraceCapacity();
  }

  private attachOperationTraceConnection(requestId: string, send: DaemonServerSend): () => void {
    const connectionCount = this.operationTraceConnections.get(requestId) ?? 0;
    if (connectionCount === 0) {
      const expiration = this.operationTraceExpirations.get(requestId);
      if (expiration !== undefined) clearTimeout(expiration);
      this.operationTraceExpirations.delete(requestId);
    }
    this.operationTraceConnections.set(requestId, connectionCount + 1);
    let connectionClosed = false;
    const disconnect = (): void => {
      if (connectionClosed) return;
      connectionClosed = true;
      const remainingConnections = (this.operationTraceConnections.get(requestId) ?? 1) - 1;
      if (remainingConnections > 0) {
        this.operationTraceConnections.set(requestId, remainingConnections);
        return;
      }
      this.operationTraceConnections.delete(requestId);
      this.disconnectOperationTrace(requestId);
    };
    send.onClose(disconnect);
    return disconnect;
  }

  private traceWasDisconnected(requestId: string): boolean {
    if (this.operationTraceExpirations.has(requestId)) return true;
    return (
      !this.operationTraces.has(requestId) &&
      !this.options.journal.isDeliveryTerminated(requestId)
    );
  }

  private reattachOperationTrace(requestId: string): void {
    if (this.options.journal.isDeliveryTerminated(requestId)) return;
    const trace = this.operationTraces.get(requestId);
    if (trace === undefined) this.options.observer.reattached(requestId);
    else trace.reattached();
  }

  private expireOperationTrace(requestId: string): void {
    this.operationTraceExpirations.delete(requestId);
    this.operationTraceConnections.delete(requestId);
    if (!this.operationTraces.delete(requestId)) return;
    this.options.observer.traceExpired(requestId);
  }

  private enforceOperationTraceCapacity(): void {
    const capacity = Math.max(1, this.options.policy.diagnostics.maximumDisconnectedTraces);
    while (this.operationTraceExpirations.size > capacity) {
      const oldestRequestId = this.operationTraceExpirations.keys().next().value as
        | string
        | undefined;
      if (oldestRequestId === undefined) return;
      const expiration = this.operationTraceExpirations.get(oldestRequestId);
      if (expiration !== undefined) clearTimeout(expiration);
      this.expireOperationTrace(oldestRequestId);
    }
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
