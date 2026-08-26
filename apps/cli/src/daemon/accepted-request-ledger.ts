import { createHash } from "node:crypto";
import type { CliExecutionRequest } from "../command-execution-result.js";
import type { DaemonExecutionFailureCode, DaemonExecutionStatus } from "./daemon-protocol.js";

export type AcceptedRequestState =
  | { readonly state: "queued"; readonly acceptedAt: number; readonly queuePosition: number }
  | { readonly state: "running"; readonly acceptedAt: number; readonly startedAt: number }
  | { readonly state: "completed"; readonly completedAt: number; readonly resultId: string }
  | {
      readonly state: "failed";
      readonly completedAt: number;
      readonly code: DaemonExecutionFailureCode;
    };

export interface AcceptedRequestEntry {
  readonly requestId: string;
  readonly requestFingerprint: string;
  readonly request: CliExecutionRequest;
  readonly state: AcceptedRequestState;
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

  constructor(private readonly now: () => number = Date.now) {}

  get size(): number {
    return this.entries.size;
  }

  accept(requestId: string, request: CliExecutionRequest): AcceptedRequestEntry {
    const requestFingerprint = AcceptedRequestLedger.fingerprint(request);
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
      request,
      state: {
        state: "queued",
        acceptedAt: this.now(),
        queuePosition: this.nonterminalCount,
      },
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
      state: { state: "running", acceptedAt: entry.state.acceptedAt, startedAt },
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
    const entry = this.transitionable(requestId);
    return this.publish({
      ...entry,
      state: { state: "failed", completedAt, code },
    });
  }

  status(requestId: string): DaemonExecutionStatus {
    const state = this.entries.get(requestId)?.state;
    if (state === undefined) return { state: "unknown" };
    if (state.state === "queued") {
      return { state: "queued", queuePosition: state.queuePosition };
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

  private static fingerprint(request: CliExecutionRequest): string {
    const canonical = AcceptedRequestLedger.canonicalValue(request);
    return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  }

  private static canonicalValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => AcceptedRequestLedger.canonicalValue(item));
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, AcceptedRequestLedger.canonicalValue(item)]),
    );
  }
}
