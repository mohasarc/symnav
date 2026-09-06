import type { DaemonObservation } from "../registry/record-observer.js";
import type { DaemonWorkspaceIdentity } from "../registry/workspace-identity.js";
import type { DaemonRecord } from "../transport/protocol.js";

export type DaemonRouteSnapshot =
  | { readonly kind: "disabled" }
  | { readonly kind: "cold"; readonly reason: "absent" | "starting" | "recovering" }
  | { readonly kind: "warm"; readonly record: DaemonRecord }
  | { readonly kind: "fallback"; readonly reason: "dead" | "incompatible" };

export interface DaemonRoutingContext {
  readonly identity: DaemonWorkspaceIdentity;
  readonly productVersion: string;
  readRecord(): DaemonRecord | undefined;
  observe(record: DaemonRecord): Promise<DaemonObservation>;
  removeIfProcess(record: DaemonRecord): boolean;
}

export interface DaemonRoutingGuard {
  evaluate(context: DaemonRoutingContext): Promise<DaemonRouteSnapshot | undefined>;
}

interface DaemonRoutingOperations {
  readonly readRecord: () => DaemonRecord | undefined;
  readonly observe: (record: DaemonRecord) => Promise<DaemonObservation>;
  readonly removeIfProcess: (record: DaemonRecord) => boolean;
}

export class DaemonRoutingContextState implements DaemonRoutingContext {
  private recordRead = false;
  private record: DaemonRecord | undefined;
  private recordFailure: unknown;
  private observation: Promise<DaemonObservation> | undefined;

  constructor(
    readonly identity: DaemonWorkspaceIdentity,
    readonly productVersion: string,
    private readonly readRecordOperation: DaemonRoutingOperations["readRecord"],
    private readonly observeOperation: DaemonRoutingOperations["observe"],
    private readonly removeIfProcessOperation: DaemonRoutingOperations["removeIfProcess"],
  ) {}

  readRecord(): DaemonRecord | undefined {
    if (!this.recordRead) {
      this.recordRead = true;
      try {
        this.record = this.readRecordOperation();
      } catch (error) {
        this.recordFailure = error;
      }
    }
    if (this.recordFailure !== undefined) throw this.recordFailure;
    return this.record;
  }

  observe(record: DaemonRecord): Promise<DaemonObservation> {
    this.observation ??= this.observeOperation(record);
    return this.observation;
  }

  removeIfProcess(record: DaemonRecord): boolean {
    return this.removeIfProcessOperation(record);
  }
}

class RecordPresentRoutingGuard implements DaemonRoutingGuard {
  async evaluate(context: DaemonRoutingContext): Promise<DaemonRouteSnapshot | undefined> {
    try {
      return context.readRecord() === undefined ? { kind: "cold", reason: "absent" } : undefined;
    } catch {
      return { kind: "cold", reason: "recovering" };
    }
  }
}

class NotStartingRoutingGuard implements DaemonRoutingGuard {
  async evaluate(context: DaemonRoutingContext): Promise<DaemonRouteSnapshot | undefined> {
    return context.readRecord()?.state === "starting"
      ? { kind: "cold", reason: "starting" }
      : undefined;
  }
}

class RecordVersionRoutingGuard implements DaemonRoutingGuard {
  async evaluate(context: DaemonRoutingContext): Promise<DaemonRouteSnapshot | undefined> {
    return context.readRecord()?.symnavVersion !== context.productVersion
      ? { kind: "fallback", reason: "incompatible" }
      : undefined;
  }
}

class ResponsiveRoutingGuard implements DaemonRoutingGuard {
  async evaluate(context: DaemonRoutingContext): Promise<DaemonRouteSnapshot> {
    const record = context.readRecord()!;
    let observation: DaemonObservation;
    try {
      observation = await context.observe(record);
    } catch {
      return { kind: "cold", reason: "recovering" };
    }
    if (observation.kind === "responsive") {
      if (observation.pong.symnavVersion !== context.productVersion) {
        return { kind: "fallback", reason: "incompatible" };
      }
      if (observation.pong.state === "starting") {
        return { kind: "cold", reason: "recovering" };
      }
      return { kind: "warm", record };
    }
    if (observation.kind === "starting") return { kind: "cold", reason: "starting" };
    if (observation.kind === "unresponsive") return { kind: "cold", reason: "recovering" };
    if (observation.kind === "exited") {
      try {
        context.removeIfProcess(record);
      } catch {}
      return { kind: "fallback", reason: "dead" };
    }
    return { kind: "fallback", reason: "incompatible" };
  }
}

export class DaemonRoutingPolicy {
  private readonly guards: readonly DaemonRoutingGuard[] = [
    new RecordPresentRoutingGuard(),
    new NotStartingRoutingGuard(),
    new RecordVersionRoutingGuard(),
    new ResponsiveRoutingGuard(),
  ];

  async decide(context: DaemonRoutingContext): Promise<DaemonRouteSnapshot> {
    for (const guard of this.guards) {
      const decision = await guard.evaluate(context);
      if (decision !== undefined) return decision;
    }
    throw new Error("Daemon routing guards did not produce a decision");
  }
}
