import type { BackendRefreshSummary } from "@symnav/core";
import type {
  CliExecutionRequest,
  CommandExecutionResult,
  CommandOutputStream,
} from "../command-execution-result.js";
import { COMMAND_OUTPUT_CHUNK_BYTES } from "./completion-spool.js";

export type DaemonExecutionFailureCode = "initialization" | "execution" | "protocol" | "resource";

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
      readonly request: CliExecutionRequest;
    }
  | {
      readonly kind: "output-ack";
      readonly generation: number;
      readonly requestId: string;
      readonly sequence: number;
    }
  | { readonly kind: "release-transient"; readonly generation: number }
  | { readonly kind: "close"; readonly generation: number };

export type DaemonNavigationWorkerResponse =
  | {
      readonly kind: "output-chunk";
      readonly generation: number;
      readonly requestId: string;
      readonly sequence: number;
      readonly stream: CommandOutputStream;
      readonly bytes: Uint8Array;
    }
  | {
      readonly kind: "ready";
      readonly generation: number;
      readonly fileCount: number;
      readonly refresh: BackendRefreshSummary;
      readonly startupDurations: WorkerStartupDurations;
    }
  | {
      readonly kind: "result";
      readonly generation: number;
      readonly requestId: string;
      readonly result: CommandExecutionResult;
      readonly refresh: BackendRefreshSummary;
      readonly durations: WorkerCommandDurations;
    }
  | {
      readonly kind: "failed";
      readonly generation: number;
      readonly requestId?: string;
      readonly failureCode: DaemonExecutionFailureCode;
      readonly errorName?: string;
    }
  | {
      readonly kind: "heap";
      readonly generation: number;
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
      this.hasKeys(value, ["kind", "generation", "requestId", "request"]) &&
      this.isNonEmptyString(value.requestId) &&
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
      (value.kind === "release-transient" || value.kind === "close") &&
      this.hasKeys(value, ["kind", "generation"])
    ) {
      return value as unknown as DaemonNavigationWorkerRequest;
    }
    throw new Error("Invalid daemon navigation worker request");
  }

  static response(value: unknown): DaemonNavigationWorkerResponse {
    if (!this.isRecord(value) || !this.isGeneration(value.generation)) {
      throw new Error("Invalid daemon navigation worker response");
    }
    if (
      value.kind === "ready" &&
      this.hasKeys(value, ["kind", "generation", "fileCount", "refresh", "startupDurations"]) &&
      this.isCount(value.fileCount) &&
      this.isRefresh(value.refresh) &&
      this.isDurations(value.startupDurations, ["discoveryMs", "indexingMs", "totalMs"])
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
      value.bytes.byteLength <= COMMAND_OUTPUT_CHUNK_BYTES
    ) {
      return value as unknown as DaemonNavigationWorkerResponse;
    }
    if (
      value.kind === "result" &&
      this.hasKeys(value, ["kind", "generation", "requestId", "result", "refresh", "durations"]) &&
      this.isNonEmptyString(value.requestId) &&
      this.isExecutionResult(value.result) &&
      this.isRefresh(value.refresh) &&
      this.isDurations(value.durations, ["freshnessMs", "navigationMs", "renderMs", "outputMs"])
    ) {
      return value as unknown as DaemonNavigationWorkerResponse;
    }
    if (value.kind === "failed" && this.isFailed(value)) {
      return value as unknown as DaemonNavigationWorkerResponse;
    }
    if (
      value.kind === "heap" &&
      this.hasKeys(value, ["kind", "generation", "usedHeapBytes", "heapLimitBytes"]) &&
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

  private static isExecutionRequest(value: unknown): value is CliExecutionRequest {
    if (!this.isRecord(value)) return false;
    const keys = ["argv", "cwd", "telemetryEnabled"];
    if (value.executionMode !== undefined) keys.push("executionMode");
    return (
      this.hasKeys(value, keys) &&
      Array.isArray(value.argv) &&
      value.argv.every((argument) => typeof argument === "string") &&
      typeof value.cwd === "string" &&
      typeof value.telemetryEnabled === "boolean" &&
      (value.executionMode === undefined ||
        value.executionMode === "cold" ||
        value.executionMode === "warm" ||
        value.executionMode === "fallback")
    );
  }

  private static isExecutionResult(value: unknown): value is CommandExecutionResult {
    if (!this.isRecord(value)) return false;
    const keys = ["frames", "exitCode"];
    return (
      this.hasKeys(value, keys) &&
      Array.isArray(value.frames) &&
      value.frames.every(
        (frame) =>
          this.isRecord(frame) &&
          this.hasKeys(frame, ["stream", "bytesBase64"]) &&
          (frame.stream === "stdout" || frame.stream === "stderr") &&
          this.isCanonicalBase64(frame.bytesBase64),
      ) &&
      this.isCount(value.exitCode)
    );
  }

  private static isRefresh(value: unknown): value is BackendRefreshSummary {
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
    if (value.errorName !== undefined) keys.push("errorName");
    return (
      this.hasKeys(value, keys) &&
      (value.requestId === undefined || this.isNonEmptyString(value.requestId)) &&
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

  private static isCanonicalBase64(value: unknown): value is string {
    return (
      typeof value === "string" &&
      value.length % 4 === 0 &&
      /^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(value) &&
      Buffer.from(value, "base64").toString("base64") === value
    );
  }

  private static isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
  }

  private static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}
