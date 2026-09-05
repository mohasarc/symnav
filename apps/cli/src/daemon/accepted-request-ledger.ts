import { createHash } from "node:crypto";
import {
  DaemonExecutionFailures,
  type AcceptedRequestCompatibility,
  type DaemonCommandName,
  type DaemonExecutorRequest,
  type DaemonExecutionFailureCode,
} from "@symnav/daemon";
import type { DaemonExecutionStatus } from "./daemon-protocol.js";
import { NodeDaemonClock, type DaemonClock } from "./daemon-clock.js";

export type AcceptedRequestState =
  | { readonly state: "queued" }
  | { readonly state: "running"; readonly startedAt: number }
  | { readonly state: "completed"; readonly completedAt: number; readonly resultId: string }
  | {
      readonly state: "failed";
      readonly completedAt: number;
      readonly code: DaemonExecutionFailureCode;
    };

export interface AcceptedRequestEntry {
  readonly requestId: string;
  readonly requestFingerprint: string;
  readonly commandName: DaemonCommandName;
  readonly request: DaemonExecutorRequest;
  readonly acceptedAt: number;
  readonly queuePosition: number;
  readonly state: AcceptedRequestState;
  readonly deliveryTerminated: boolean;
}

export type AcceptedRequestSubscriber = (entry: AcceptedRequestEntry) => void;

export class AcceptedRequestCorruptionError extends Error {
  constructor(readonly requestId: string) {
    super(`Accepted request identifier ${requestId} has a different payload`);
    this.name = "AcceptedRequestCorruptionError";
  }
}

export class AcceptedRequestLedger {
  private readonly entries = new Map<string, AcceptedRequestEntry>();
  private readonly subscribers = new Map<string, Set<AcceptedRequestSubscriber>>();
  private readonly acknowledged = new Set<string>();

  constructor(private readonly clock: Pick<DaemonClock, "wallNowMs"> = new NodeDaemonClock()) {}

  get size(): number {
    return this.entries.size;
  }

  get hasUnacknowledgedCompletions(): boolean {
    for (const entry of this.entries.values()) {
      if (entry.state.state === "completed" && !this.acknowledged.has(entry.requestId)) return true;
    }
    return false;
  }

  compatibilityFor(
    requestId: string,
    commandName: DaemonCommandName,
    request: DaemonExecutorRequest,
  ): AcceptedRequestCompatibility {
    const existing = this.entries.get(requestId);
    if (existing === undefined) return "unseen";
    const requestFingerprint = AcceptedRequestLedger.fingerprint(commandName, request);
    return existing.requestFingerprint === requestFingerprint ? "matching" : "conflicting";
  }

  accept(
    requestId: string,
    commandName: DaemonCommandName,
    request: DaemonExecutorRequest,
  ): AcceptedRequestEntry {
    const requestFingerprint = AcceptedRequestLedger.fingerprint(commandName, request);
    const existing = this.entries.get(requestId);
    if (existing !== undefined) {
      if (existing.requestFingerprint !== requestFingerprint) {
        throw new AcceptedRequestCorruptionError(requestId);
      }
      return existing;
    }
    const entry: AcceptedRequestEntry = {
      requestId,
      requestFingerprint,
      commandName,
      request,
      acceptedAt: this.clock.wallNowMs(),
      queuePosition: this.nonterminalCount,
      deliveryTerminated: false,
      state: { state: "queued" },
    };
    this.entries.set(requestId, entry);
    return entry;
  }

  markRunning(requestId: string, startedAt: number): AcceptedRequestEntry {
    const entry = this.transitionable(requestId);
    if (entry.state.state !== "queued") {
      throw new Error(`Accepted request ${requestId} is already ${entry.state.state}`);
    }
    return this.publish({
      ...entry,
      state: { state: "running", startedAt },
    });
  }

  complete(requestId: string, resultId: string, completedAt: number): AcceptedRequestEntry {
    const entry = this.transitionable(requestId);
    return this.publish({
      ...entry,
      state: { state: "completed", completedAt, resultId },
    });
  }

  fail(
    requestId: string,
    code: DaemonExecutionFailureCode,
    completedAt: number,
  ): AcceptedRequestEntry {
    AcceptedRequestLedger.assertFailureCode(code);
    const entry = this.transitionable(requestId);
    return this.publish({
      ...entry,
      state: { state: "failed", completedAt, code },
    });
  }

  invalidateCompletion(
    requestId: string,
    code: DaemonExecutionFailureCode,
    completedAt: number,
  ): AcceptedRequestEntry {
    AcceptedRequestLedger.assertFailureCode(code);
    const entry = this.entry(requestId);
    if (entry.state.state === "failed" && entry.state.code === code) return entry;
    if (entry.state.state !== "completed") {
      throw new Error(`Accepted request ${requestId} is not completed`);
    }
    return this.publish({
      ...entry,
      state: { state: "failed", completedAt, code },
    });
  }

  private static assertFailureCode(code: unknown): asserts code is DaemonExecutionFailureCode {
    if (!DaemonExecutionFailures.isCode(code)) {
      throw new Error("Invalid daemon execution failure code");
    }
  }

  status(requestId: string): DaemonExecutionStatus {
    const entry = this.entries.get(requestId);
    if (entry === undefined) return { state: "unknown" };
    const state = entry.state;
    if (state.state === "queued") {
      return { state: "queued", queuePosition: entry.queuePosition };
    }
    if (state.state === "running") return { state: "running", startedAt: state.startedAt };
    if (state.state === "completed") return { state: "completed" };
    return { state: "failed", code: state.code };
  }

  acknowledge(requestId: string): void {
    const entry = this.entry(requestId);
    if (entry.state.state !== "completed" && entry.state.state !== "failed") {
      throw new Error(`Accepted request ${requestId} is not terminal`);
    }
    this.acknowledged.add(requestId);
  }

  isAcknowledged(requestId: string): boolean {
    return this.acknowledged.has(requestId);
  }

  terminateDelivery(requestId: string): boolean {
    const entry = this.entry(requestId);
    if (entry.deliveryTerminated) return false;
    this.entries.set(requestId, { ...entry, deliveryTerminated: true });
    return true;
  }

  isDeliveryTerminated(requestId: string): boolean {
    return this.entry(requestId).deliveryTerminated;
  }

  subscribe(requestId: string, subscriber: AcceptedRequestSubscriber): () => void {
    const entry = this.entry(requestId);
    let requestSubscribers = this.subscribers.get(requestId);
    if (requestSubscribers === undefined) {
      requestSubscribers = new Set();
      this.subscribers.set(requestId, requestSubscribers);
    }
    requestSubscribers.add(subscriber);
    subscriber(entry);
    return () => {
      requestSubscribers?.delete(subscriber);
      if (requestSubscribers?.size === 0) this.subscribers.delete(requestId);
    };
  }

  entryFor(requestId: string): AcceptedRequestEntry | undefined {
    return this.entries.get(requestId);
  }

  private get nonterminalCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.state.state === "queued" || entry.state.state === "running") count += 1;
    }
    return count;
  }

  private transitionable(requestId: string): AcceptedRequestEntry {
    const entry = this.entry(requestId);
    if (entry.state.state === "completed" || entry.state.state === "failed") {
      throw new Error(`Accepted request ${requestId} is already ${entry.state.state}`);
    }
    return entry;
  }

  private entry(requestId: string): AcceptedRequestEntry {
    const entry = this.entries.get(requestId);
    if (entry === undefined) throw new Error(`Accepted request ${requestId} was not accepted`);
    return entry;
  }

  private publish(entry: AcceptedRequestEntry): AcceptedRequestEntry {
    this.entries.set(entry.requestId, entry);
    for (const subscriber of this.subscribers.get(entry.requestId) ?? []) subscriber(entry);
    return entry;
  }

  private static fingerprint(
    commandName: DaemonCommandName,
    request: DaemonExecutorRequest,
  ): string {
    const canonical = AcceptedRequestLedger.canonicalValue({ commandName, request });
    return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  }

  private static canonicalValue(value: unknown): unknown {
    if (Array.isArray(value))
      return value.map((item) => AcceptedRequestLedger.canonicalValue(item));
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, AcceptedRequestLedger.canonicalValue(item)]),
    );
  }
}
