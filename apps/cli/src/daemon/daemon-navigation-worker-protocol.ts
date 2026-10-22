import {
  DaemonDiagnosticValues,
  type DaemonCommandName,
  type DaemonDiagnostics,
  type DaemonExecutorRequest,
  type DaemonOutputStream,
  type DaemonWorkerFailureCode,
} from "@symnav/daemon";
import { DaemonRuntimeValues } from "./daemon-runtime-values.js";
import type { DaemonRefreshSummary } from "./daemon-protocol.js";

export interface WorkerStartupDurations {
  readonly discoveryMs: number;
  readonly indexingMs: number;
  readonly totalMs: number;
}

export interface WorkerCommandDurations {
  readonly freshnessMs: number;
  readonly navigationMs: number;
  readonly renderMs: number;
  readonly outputMs: number;
}

export type DaemonNavigationWorkerRequest =
  | { readonly kind: "initialize"; readonly generation: number; readonly workspaceRoot: string }
  | {
      readonly kind: "execute";
      readonly generation: number;
      readonly requestId: string;
      readonly commandName: DaemonCommandName;
      readonly request: DaemonExecutorRequest;
    }
  | {
      readonly kind: "output-ack";
      readonly generation: number;
      readonly requestId: string;
      readonly sequence: number;
    }
  | {
      readonly kind: "release-transient";
      readonly generation: number;
      readonly operationId: string;
    }
  | { readonly kind: "close"; readonly generation: number };

export type DaemonNavigationWorkerResponse =
  | {
      readonly kind: "output-chunk";
      readonly generation: number;
      readonly requestId: string;
      readonly sequence: number;
      readonly stream: DaemonOutputStream;
      readonly bytes: Uint8Array;
    }
  | {
      readonly kind: "ready";
      readonly generation: number;
      readonly fileCount: number;
      readonly refresh: DaemonRefreshSummary;
      readonly startupDurations: WorkerStartupDurations;
      readonly diagnostics?: DaemonDiagnostics;
    }
  | {
      readonly kind: "result";
      readonly generation: number;
      readonly requestId: string;
      readonly result: { readonly exitCode: number };
      readonly refresh: DaemonRefreshSummary;
      readonly durations: WorkerCommandDurations;
      readonly diagnostics?: DaemonDiagnostics;
      readonly resources: {
        readonly workerHeapUsedBytes: number;
        readonly peakWorkerHeapUsedBytes: number;
        readonly workerHeapLimitBytes: number;
      };
    }
  | {
      readonly kind: "failed";
      readonly generation: number;
      readonly requestId?: string;
      readonly failureCode: DaemonWorkerFailureCode;
      readonly errorName?: string;
      readonly operationId?: string;
    }
  | {
      readonly kind: "heap";
      readonly generation: number;
      readonly operationId: string;
      readonly usedHeapBytes: number;
      readonly heapLimitBytes: number;
    }
  | { readonly kind: "closed"; readonly generation: number };

export class DaemonNavigationWorkerProtocol {
  static request(value: unknown): DaemonNavigationWorkerRequest {
    if (!this.isRecord(value) || !this.isGeneration(value.generation)) {
      throw new Error("Invalid daemon navigation worker request");
    }
    if (
      value.kind === "initialize" &&
      this.hasKeys(value, ["kind", "generation", "workspaceRoot"]) &&
      this.isNonEmptyString(value.workspaceRoot)
    ) {
      return value as unknown as DaemonNavigationWorkerRequest;
    }
    if (
      value.kind === "execute" &&
      this.hasKeys(value, ["kind", "generation", "requestId", "commandName", "request"]) &&
      this.isNonEmptyString(value.requestId) &&
      DaemonRuntimeValues.isCommandName(value.commandName) &&
      this.isExecutionRequest(value.request)
    ) {
      return value as unknown as DaemonNavigationWorkerRequest;
    }
    if (
      value.kind === "output-ack" &&
      this.hasKeys(value, ["kind", "generation", "requestId", "sequence"]) &&
      this.isNonEmptyString(value.requestId) &&
      this.isCount(value.sequence)
    ) {
      return value as unknown as DaemonNavigationWorkerRequest;
    }
    if (
      value.kind === "release-transient" &&
      this.hasKeys(value, ["kind", "generation", "operationId"]) &&
      this.isNonEmptyString(value.operationId)
    ) {
      return value as unknown as DaemonNavigationWorkerRequest;
    }
    if (value.kind === "close" && this.hasKeys(value, ["kind", "generation"])) {
      return value as unknown as DaemonNavigationWorkerRequest;
    }
    throw new Error("Invalid daemon navigation worker request");
  }

  static response(value: unknown, maximumChunkRawBytes: number): DaemonNavigationWorkerResponse {
    if (!this.isRecord(value) || !this.isGeneration(value.generation)) {
      throw new Error("Invalid daemon navigation worker response");
    }
    if (
      value.kind === "ready" &&
      this.hasKeys(
        value,
        this.keysWithDiagnostics(
          ["kind", "generation", "fileCount", "refresh", "startupDurations"],
          value,
        ),
      ) &&
      this.isCount(value.fileCount) &&
      this.isRefresh(value.refresh) &&
      this.isDurations(value.startupDurations, ["discoveryMs", "indexingMs", "totalMs"]) &&
      this.isDiagnostics(value.diagnostics)
    ) {
      return value as unknown as DaemonNavigationWorkerResponse;
    }
    if (
      value.kind === "output-chunk" &&
      this.hasKeys(value, ["kind", "generation", "requestId", "sequence", "stream", "bytes"]) &&
      this.isNonEmptyString(value.requestId) &&
      this.isCount(value.sequence) &&
      (value.stream === "stdout" || value.stream === "stderr") &&
      value.bytes instanceof Uint8Array &&
      value.bytes.byteLength <= maximumChunkRawBytes
    ) {
      return value as unknown as DaemonNavigationWorkerResponse;
    }
    if (
      value.kind === "result" &&
      this.hasKeys(
        value,
        this.keysWithDiagnostics(
          ["kind", "generation", "requestId", "result", "refresh", "durations", "resources"],
          value,
        ),
      ) &&
      this.isNonEmptyString(value.requestId) &&
      this.isExecutionResult(value.result) &&
      this.isRefresh(value.refresh) &&
      this.isDurations(value.durations, ["freshnessMs", "navigationMs", "renderMs", "outputMs"]) &&
      this.isDiagnostics(value.diagnostics) &&
      this.isWorkerResources(value.resources)
    ) {
      return value as unknown as DaemonNavigationWorkerResponse;
    }
    if (value.kind === "failed" && this.isFailed(value)) {
      return value as unknown as DaemonNavigationWorkerResponse;
    }
    if (
      value.kind === "heap" &&
      this.hasKeys(value, [
        "kind",
        "generation",
        "operationId",
        "usedHeapBytes",
        "heapLimitBytes",
      ]) &&
      this.isNonEmptyString(value.operationId) &&
      this.isCount(value.usedHeapBytes) &&
      this.isCount(value.heapLimitBytes)
    ) {
      return value as unknown as DaemonNavigationWorkerResponse;
    }
    if (value.kind === "closed" && this.hasKeys(value, ["kind", "generation"])) {
      return value as unknown as DaemonNavigationWorkerResponse;
    }
    throw new Error("Invalid daemon navigation worker response");
  }

  private static isWorkerResources(value: unknown): boolean {
    return (
      this.isRecord(value) &&
      this.hasKeys(value, [
        "workerHeapUsedBytes",
        "peakWorkerHeapUsedBytes",
        "workerHeapLimitBytes",
      ]) &&
      this.isCount(value.workerHeapUsedBytes) &&
      this.isCount(value.peakWorkerHeapUsedBytes) &&
      this.isCount(value.workerHeapLimitBytes) &&
      value.peakWorkerHeapUsedBytes >= value.workerHeapUsedBytes
    );
  }

  private static isExecutionRequest(value: unknown): value is DaemonExecutorRequest {
    if (!this.isRecord(value)) return false;
    return (
      this.hasKeys(value, ["argv", "cwd", "telemetryEnabled", "executionMode"]) &&
      Array.isArray(value.argv) &&
      value.argv.every((argument) => typeof argument === "string") &&
      typeof value.cwd === "string" &&
      typeof value.telemetryEnabled === "boolean" &&
      (value.executionMode === "cold" ||
        value.executionMode === "warm" ||
        value.executionMode === "fallback")
    );
  }

  private static isDiagnostics(value: unknown): value is DaemonDiagnostics | undefined {
    return value === undefined || DaemonDiagnosticValues.isDiagnostics(value);
  }

  private static keysWithDiagnostics(
    keys: readonly string[],
    value: Record<string, unknown>,
  ): readonly string[] {
    return value.diagnostics === undefined ? keys : [...keys, "diagnostics"];
  }

  private static isExecutionResult(value: unknown): value is { readonly exitCode: number } {
    return (
      this.isRecord(value) && this.hasKeys(value, ["exitCode"]) && this.isCount(value.exitCode)
    );
  }

  private static isRefresh(value: unknown): value is DaemonRefreshSummary {
    return (
      this.isRecord(value) &&
      this.hasKeys(value, ["added", "changed", "removed", "unchanged"]) &&
      this.isCount(value.added) &&
      this.isCount(value.changed) &&
      this.isCount(value.removed) &&
      this.isCount(value.unchanged)
    );
  }

  private static isFailed(value: Record<string, unknown>): boolean {
    const keys = ["kind", "generation", "failureCode"];
    if (value.requestId !== undefined) keys.push("requestId");
    if (value.operationId !== undefined) keys.push("operationId");
    if (value.errorName !== undefined) keys.push("errorName");
    return (
      this.hasKeys(value, keys) &&
      (value.requestId === undefined || this.isNonEmptyString(value.requestId)) &&
      (value.operationId === undefined || this.isNonEmptyString(value.operationId)) &&
      !(value.requestId !== undefined && value.operationId !== undefined) &&
      (value.failureCode === "initialization" ||
        value.failureCode === "execution" ||
        value.failureCode === "protocol" ||
        value.failureCode === "resource") &&
      (value.errorName === undefined || this.isNonEmptyString(value.errorName))
    );
  }

  private static isDurations(value: unknown, keys: readonly string[]): boolean {
    return (
      this.isRecord(value) &&
      this.hasKeys(value, keys) &&
      keys.every((key) => this.isMetric(value[key]))
    );
  }

  private static hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const actual = Object.keys(value).sort();
    return (
      actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
    );
  }

  private static isGeneration(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) >= 0;
  }

  private static isCount(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) >= 0;
  }

  private static isMetric(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
  }

  private static isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
  }

  private static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}
