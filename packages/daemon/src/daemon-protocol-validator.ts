import {
  DaemonAdmissionRejections,
  DaemonExecutionFailures,
  type DaemonRejectedExecutionFrame,
} from "@symnav/daemon";
import type { CompletionSpoolManifest } from "./completion-spool.js";
import type {
  DaemonExecuteRequest,
  DaemonExecutionServerFrame,
  DaemonExecutionStatus,
  DaemonExecutionStatusRequest,
  DaemonExecutionStatusResponse,
  DaemonLifecycleRequest,
  DaemonLifecycleResponse,
  DaemonRequest,
  DaemonResponse,
} from "./daemon-protocol.js";
import { DaemonRuntimeValues } from "./daemon-runtime-values.js";

export class DaemonProtocolError extends Error {
  constructor(
    readonly code: "authentication" | "corrupt" | "incompatible",
    message: string,
    readonly authenticatedInstanceId?: string,
  ) {
    super(message);
  }
}

export class DaemonProtocolValidator {
  lifecycleRequest(value: unknown): DaemonLifecycleRequest {
    const request = this.request(value);
    if (
      request.kind !== "identify" &&
      request.kind !== "terminate" &&
      request.kind !== "kill" &&
      request.kind !== "ping" &&
      request.kind !== "stop"
    ) {
      throw new Error("Malformed daemon lifecycle request");
    }
    return request;
  }

  request(value: unknown): DaemonRequest {
    if (!DaemonProtocolValidator.isRecord(value) || typeof value.kind !== "string") {
      throw new Error("Malformed daemon request");
    }
    if (value.kind === "identify" || value.kind === "terminate" || value.kind === "kill") {
      if (
        !DaemonProtocolValidator.hasExactKeys(value, ["kind", "instanceId", "processToken"]) ||
        !DaemonProtocolValidator.isRuntimeString(value.instanceId) ||
        !DaemonProtocolValidator.isRuntimeString(value.processToken)
      ) {
        throw new Error("Malformed daemon identity request");
      }
      return value as unknown as DaemonRequest;
    }
    if (
      !DaemonProtocolValidator.isProtocolVersion(value.protocolVersion) ||
      !DaemonProtocolValidator.isRuntimeString(value.instanceId)
    ) {
      throw new Error("Malformed daemon request envelope");
    }
    if (value.kind === "ping" || value.kind === "stop") {
      if (!DaemonProtocolValidator.hasExactKeys(value, ["kind", "protocolVersion", "instanceId"])) {
        throw new Error("Malformed daemon request envelope");
      }
      return value as unknown as DaemonRequest;
    }
    if (!DaemonProtocolValidator.isExecutionRequestEnvelope(value)) {
      throw new Error("Malformed daemon execution request");
    }
    return value as unknown as DaemonRequest;
  }

  lifecycleResponse(request: DaemonLifecycleRequest, value: unknown): DaemonLifecycleResponse {
    const response = this.response(value);
    if (request.kind === "identify") {
      if (response.kind !== "identity") {
        throw new DaemonProtocolError("corrupt", "Daemon returned a non-identity response");
      }
      if (
        response.instanceId !== request.instanceId ||
        response.processToken !== request.processToken
      ) {
        throw new DaemonProtocolError(
          "authentication",
          "Daemon identity does not match process instance",
          response.instanceId === request.instanceId ? response.instanceId : undefined,
        );
      }
      return response;
    }
    if (request.kind === "terminate" || request.kind === "kill") {
      const expectedKind = request.kind === "terminate" ? "terminating" : "killing";
      if (response.kind !== expectedKind) {
        throw new DaemonProtocolError("corrupt", "Daemon returned a non-termination response");
      }
      if (
        response.instanceId !== request.instanceId ||
        response.processToken !== request.processToken
      ) {
        throw new DaemonProtocolError(
          "authentication",
          "Daemon termination does not match process instance",
          response.instanceId === request.instanceId ? response.instanceId : undefined,
        );
      }
      return response;
    }
    if (request.kind === "ping") {
      if (response.kind !== "pong") {
        throw new DaemonProtocolError(
          "corrupt",
          "Daemon pong does not match request protocol and instance",
        );
      }
      if (response.instanceId !== request.instanceId) {
        throw new DaemonProtocolError(
          "authentication",
          "Daemon pong does not match request instance",
        );
      }
      if (response.protocolVersion !== request.protocolVersion) {
        throw new DaemonProtocolError(
          "incompatible",
          "Daemon pong does not match request protocol",
          response.instanceId,
        );
      }
      return response;
    }
    if (response.kind !== "stopped") {
      throw new DaemonProtocolError("corrupt", "Daemon returned a non-stop response");
    }
    if (response.instanceId !== request.instanceId) {
      throw new DaemonProtocolError(
        "authentication",
        "Daemon stop response does not match instance",
      );
    }
    return response;
  }

  executionStatusResponse(
    request: DaemonExecutionStatusRequest,
    value: unknown,
  ): DaemonExecutionStatusResponse {
    const response = this.response(value);
    if (response.kind !== "execution-status") {
      throw new DaemonProtocolError("corrupt", "Daemon returned a non-status response");
    }
    this.assertExecutionCoordinates(request, response);
    return response;
  }

  executionFrame(
    request: Pick<DaemonExecuteRequest, "instanceId" | "processToken" | "requestId">,
    value: unknown,
  ): DaemonExecutionServerFrame {
    const response = this.response(value);
    if (
      response.kind !== "accepted" &&
      response.kind !== "rejected" &&
      response.kind !== "result-manifest" &&
      response.kind !== "result-end" &&
      response.kind !== "execution-failed"
    ) {
      throw new DaemonProtocolError("corrupt", "Daemon returned a non-execution frame");
    }
    this.assertExecutionCoordinates(request, response);
    return response;
  }

  resultAcknowledgement(
    request: Pick<DaemonExecuteRequest, "instanceId" | "processToken" | "requestId">,
    transferId: string,
    value: unknown,
  ): void {
    const response = this.response(value);
    if (
      response.kind !== "result-acknowledged" ||
      response.instanceId !== request.instanceId ||
      response.processToken !== request.processToken ||
      response.requestId !== request.requestId ||
      response.transferId !== transferId
    ) {
      throw new Error("Invalid daemon result acknowledgement");
    }
  }

  private response(value: unknown): DaemonResponse {
    if (!DaemonProtocolValidator.isRecord(value) || typeof value.kind !== "string") {
      throw new Error("Malformed daemon response");
    }
    if (value.kind === "pong") {
      this.assertPong(value);
      return value as unknown as DaemonResponse;
    }
    if (value.kind === "identity") {
      if (
        !DaemonProtocolValidator.hasExactKeys(value, [
          "kind",
          "instanceId",
          "processToken",
          "pid",
          "startedAt",
        ]) ||
        !DaemonProtocolValidator.isRuntimeString(value.instanceId) ||
        !DaemonProtocolValidator.isRuntimeString(value.processToken) ||
        !DaemonProtocolValidator.isPositiveInteger(value.pid) ||
        !DaemonProtocolValidator.isMetric(value.startedAt)
      ) {
        throw new Error("Malformed daemon identity");
      }
      return value as unknown as DaemonResponse;
    }
    if (value.kind === "terminating" || value.kind === "killing") {
      if (
        !DaemonProtocolValidator.hasExactKeys(value, ["kind", "instanceId", "processToken"]) ||
        !DaemonProtocolValidator.isRuntimeString(value.instanceId) ||
        !DaemonProtocolValidator.isRuntimeString(value.processToken)
      ) {
        throw new Error("Malformed daemon termination response");
      }
      return value as unknown as DaemonResponse;
    }
    if (value.kind === "stopped") {
      if (
        !DaemonProtocolValidator.hasExactKeys(value, ["kind", "instanceId"]) ||
        !DaemonProtocolValidator.isRuntimeString(value.instanceId)
      ) {
        throw new Error("Malformed daemon stop response");
      }
      return value as unknown as DaemonResponse;
    }
    if (
      value.kind === "accepted" ||
      value.kind === "rejected" ||
      value.kind === "result-manifest" ||
      value.kind === "result-end" ||
      value.kind === "execution-failed"
    ) {
      this.assertExecutionFrame(value);
      return value as unknown as DaemonResponse;
    }
    if (value.kind === "execution-status") {
      if (
        !DaemonProtocolValidator.hasExactKeys(value, [
          "kind",
          "instanceId",
          "processToken",
          "requestId",
          "status",
        ]) ||
        !DaemonProtocolValidator.isRuntimeString(value.instanceId) ||
        !DaemonProtocolValidator.isRuntimeString(value.processToken) ||
        !DaemonRuntimeValues.isRequestId(value.requestId) ||
        !DaemonProtocolValidator.isExecutionStatus(value.status)
      ) {
        throw new Error("Malformed daemon execution status");
      }
      return value as unknown as DaemonResponse;
    }
    if (value.kind === "result-acknowledged") {
      if (
        !DaemonProtocolValidator.hasExactKeys(value, [
          "kind",
          "instanceId",
          "processToken",
          "requestId",
          "transferId",
        ]) ||
        !DaemonProtocolValidator.isRuntimeString(value.instanceId) ||
        !DaemonProtocolValidator.isRuntimeString(value.processToken) ||
        !DaemonRuntimeValues.isRequestId(value.requestId) ||
        !DaemonProtocolValidator.isRuntimeString(value.transferId)
      ) {
        throw new Error("Malformed daemon result acknowledgement");
      }
      return value as unknown as DaemonResponse;
    }
    throw new Error("Malformed daemon response");
  }

  private assertExecutionCoordinates(
    request: Pick<DaemonExecuteRequest, "instanceId" | "processToken" | "requestId">,
    response: Pick<DaemonExecutionServerFrame, "instanceId" | "processToken" | "requestId">,
  ): void {
    if (response.instanceId !== request.instanceId) {
      throw new DaemonProtocolError("authentication", "Daemon execution instance does not match");
    }
    if (response.processToken !== request.processToken) {
      throw new DaemonProtocolError(
        "authentication",
        "Daemon execution process token does not match",
        response.instanceId,
      );
    }
    if (response.requestId !== request.requestId) {
      throw new DaemonProtocolError(
        "corrupt",
        "Daemon execution request identifier does not match",
        response.instanceId,
      );
    }
  }

  private assertExecutionFrame(value: Record<string, unknown>): void {
    if (
      !DaemonProtocolValidator.isRuntimeString(value.instanceId) ||
      !DaemonProtocolValidator.isRuntimeString(value.processToken) ||
      !DaemonRuntimeValues.isRequestId(value.requestId)
    ) {
      throw new Error("Malformed daemon execution frame");
    }
    if (value.kind === "accepted") {
      if (
        !DaemonProtocolValidator.hasExactKeys(value, [
          "kind",
          "instanceId",
          "processToken",
          "requestId",
          "acceptedAt",
          "queuePosition",
        ]) ||
        !DaemonProtocolValidator.isMetric(value.acceptedAt) ||
        !DaemonProtocolValidator.isCount(value.queuePosition)
      ) {
        throw new Error("Malformed daemon acceptance");
      }
      return;
    }
    if (value.kind === "rejected") {
      if (
        !DaemonProtocolValidator.hasExactKeys(value, [
          "kind",
          "instanceId",
          "processToken",
          "requestId",
          "code",
          "retrySafe",
        ]) ||
        typeof value.retrySafe !== "boolean"
      ) {
        throw new Error("Malformed daemon execution rejection");
      }
      try {
        DaemonAdmissionRejections.assertConsistent(
          value as unknown as DaemonRejectedExecutionFrame,
        );
      } catch {
        throw new Error("Malformed daemon execution rejection");
      }
      return;
    }
    if (value.kind === "result-manifest") {
      if (
        !DaemonProtocolValidator.hasExactKeys(value, [
          "kind",
          "instanceId",
          "processToken",
          "requestId",
          "manifest",
        ]) ||
        !DaemonProtocolValidator.isCompletionManifest(value.manifest) ||
        value.manifest.instanceId !== value.instanceId ||
        value.manifest.requestId !== value.requestId
      ) {
        throw new Error("Malformed daemon result manifest");
      }
      return;
    }
    if (value.kind === "result-end") {
      if (
        !DaemonProtocolValidator.hasExactKeys(value, [
          "kind",
          "instanceId",
          "processToken",
          "requestId",
          "transferId",
          "rawBytes",
          "recordCount",
          "sha256",
        ]) ||
        !DaemonProtocolValidator.isRuntimeString(value.transferId) ||
        !DaemonProtocolValidator.isCount(value.rawBytes) ||
        !DaemonProtocolValidator.isCount(value.recordCount) ||
        !DaemonProtocolValidator.isDigest(value.sha256)
      ) {
        throw new Error("Malformed daemon result end");
      }
      return;
    }
    if (
      !DaemonProtocolValidator.hasExactKeys(value, [
        "kind",
        "instanceId",
        "processToken",
        "requestId",
        "code",
      ]) ||
      !DaemonExecutionFailures.isCode(value.code)
    ) {
      throw new Error("Malformed daemon execution failure");
    }
  }

  private assertPong(value: Record<string, unknown>): void {
    const expectedKeys = ["kind", "protocolVersion", "instanceId", "symnavVersion"];
    for (const optionalKey of [
      "state",
      "startedAt",
      "fileCount",
      "memoryBytes",
      "lastNavigationAt",
      "currentCommand",
      "currentCommandElapsedMs",
      "queued",
      "activity",
    ]) {
      if (value[optionalKey] !== undefined) expectedKeys.push(optionalKey);
    }
    if (
      !DaemonProtocolValidator.hasExactKeys(value, expectedKeys) ||
      !DaemonProtocolValidator.isProtocolVersion(value.protocolVersion) ||
      !DaemonProtocolValidator.isRuntimeString(value.instanceId) ||
      !DaemonProtocolValidator.isRuntimeString(value.symnavVersion) ||
      (value.state !== undefined &&
        value.state !== "starting" &&
        value.state !== "ready" &&
        value.state !== "busy") ||
      (value.startedAt !== undefined && !DaemonProtocolValidator.isMetric(value.startedAt)) ||
      (value.fileCount !== undefined && !DaemonProtocolValidator.isCount(value.fileCount)) ||
      (value.memoryBytes !== undefined && !DaemonProtocolValidator.isCount(value.memoryBytes)) ||
      (value.lastNavigationAt !== undefined &&
        !DaemonProtocolValidator.isMetric(value.lastNavigationAt)) ||
      (value.currentCommand !== undefined &&
        !DaemonRuntimeValues.isCommandName(value.currentCommand)) ||
      (value.currentCommandElapsedMs !== undefined &&
        !DaemonProtocolValidator.isMetric(value.currentCommandElapsedMs)) ||
      (value.queued !== undefined && !DaemonProtocolValidator.isCount(value.queued)) ||
      (value.activity !== undefined && !DaemonProtocolValidator.isActivitySnapshot(value.activity))
    ) {
      throw new Error("Malformed daemon pong");
    }
  }

  private static isExecutionRequestEnvelope(value: Record<string, unknown>): boolean {
    if (
      (value.kind !== "execute" &&
        value.kind !== "execution-status" &&
        value.kind !== "result-fetch" &&
        value.kind !== "result-ack") ||
      !DaemonProtocolValidator.isRuntimeString(value.processToken) ||
      !DaemonRuntimeValues.isRequestId(value.requestId)
    ) {
      return false;
    }
    if (value.kind === "execute") {
      return (
        DaemonProtocolValidator.hasExactKeys(value, [
          "kind",
          "protocolVersion",
          "instanceId",
          "processToken",
          "requestId",
          "commandName",
          "request",
        ]) &&
        DaemonRuntimeValues.isCommandName(value.commandName) &&
        DaemonProtocolValidator.isExecutorRequest(value.request)
      );
    }
    if (value.kind === "result-fetch") {
      return (
        DaemonProtocolValidator.hasExactKeys(value, [
          "kind",
          "protocolVersion",
          "instanceId",
          "processToken",
          "requestId",
          "offset",
        ]) && DaemonProtocolValidator.isCount(value.offset)
      );
    }
    if (value.kind === "result-ack") {
      return (
        DaemonProtocolValidator.hasExactKeys(value, [
          "kind",
          "protocolVersion",
          "instanceId",
          "processToken",
          "requestId",
          "transferId",
        ]) && DaemonProtocolValidator.isRuntimeString(value.transferId)
      );
    }
    return DaemonProtocolValidator.hasExactKeys(value, [
      "kind",
      "protocolVersion",
      "instanceId",
      "processToken",
      "requestId",
    ]);
  }

  private static isExecutorRequest(value: unknown): boolean {
    if (!DaemonProtocolValidator.isRecord(value)) return false;
    return (
      DaemonProtocolValidator.hasExactKeys(value, [
        "argv",
        "cwd",
        "telemetryEnabled",
        "executionMode",
      ]) &&
      Array.isArray(value.argv) &&
      value.argv.every((argument) => typeof argument === "string") &&
      typeof value.cwd === "string" &&
      value.cwd.length > 0 &&
      typeof value.telemetryEnabled === "boolean" &&
      (value.executionMode === "cold" ||
        value.executionMode === "warm" ||
        value.executionMode === "fallback")
    );
  }

  private static isCompletionManifest(value: unknown): value is CompletionSpoolManifest {
    return (
      DaemonProtocolValidator.isRecord(value) &&
      DaemonProtocolValidator.hasExactKeys(value, [
        "transferId",
        "requestId",
        "instanceId",
        "exitCode",
        "rawBytes",
        "recordCount",
        "sha256",
      ]) &&
      DaemonProtocolValidator.isRuntimeString(value.transferId) &&
      DaemonRuntimeValues.isRequestId(value.requestId) &&
      DaemonProtocolValidator.isRuntimeString(value.instanceId) &&
      DaemonProtocolValidator.isCount(value.exitCode) &&
      DaemonProtocolValidator.isCount(value.rawBytes) &&
      DaemonProtocolValidator.isCount(value.recordCount) &&
      DaemonProtocolValidator.isDigest(value.sha256)
    );
  }

  private static isExecutionStatus(value: unknown): value is DaemonExecutionStatus {
    if (!DaemonProtocolValidator.isRecord(value)) return false;
    if (value.state === "unknown" || value.state === "completed") {
      return DaemonProtocolValidator.hasExactKeys(value, ["state"]);
    }
    if (value.state === "queued") {
      return (
        DaemonProtocolValidator.hasExactKeys(value, ["state", "queuePosition"]) &&
        DaemonProtocolValidator.isCount(value.queuePosition)
      );
    }
    if (value.state === "running") {
      return (
        DaemonProtocolValidator.hasExactKeys(value, ["state", "startedAt"]) &&
        DaemonProtocolValidator.isMetric(value.startedAt)
      );
    }
    return (
      value.state === "failed" &&
      DaemonProtocolValidator.hasExactKeys(value, ["state", "code"]) &&
      DaemonExecutionFailures.isCode(value.code)
    );
  }

  private static isActivitySnapshot(value: unknown): boolean {
    if (!DaemonProtocolValidator.isRecord(value)) return false;
    const lifecycle = value.lifecycle;
    const current = value.current;
    const expectedKeys = [
      "lifecycle",
      "pid",
      "startedAt",
      "startupElapsedMs",
      "processRssBytes",
      "hardProcessRssBytes",
      "workerGeneration",
      "queued",
      "spoolBytes",
    ];
    if (value.workerHeapUsedBytes !== undefined) expectedKeys.push("workerHeapUsedBytes");
    if (value.lastCompletedAgoMs !== undefined) expectedKeys.push("lastCompletedAgoMs");
    if (
      lifecycle === "ready" ||
      lifecycle === "busy" ||
      ((lifecycle === "recovering" || lifecycle === "draining") && value.fileCount !== undefined)
    ) {
      expectedKeys.push("fileCount");
    }
    if (lifecycle === "busy") expectedKeys.push("current");
    if (lifecycle === "recovering") expectedKeys.push("recoveryDetail");
    return (
      (lifecycle === "starting" ||
        lifecycle === "ready" ||
        lifecycle === "busy" ||
        lifecycle === "recovering" ||
        lifecycle === "draining") &&
      DaemonProtocolValidator.hasExactKeys(value, expectedKeys) &&
      (lifecycle !== "recovering" ||
        value.recoveryDetail === "resource-pressure" ||
        value.recoveryDetail === "worker-replacement") &&
      DaemonProtocolValidator.isPositiveInteger(value.pid) &&
      DaemonProtocolValidator.isMetric(value.startedAt) &&
      DaemonProtocolValidator.isMetric(value.startupElapsedMs) &&
      (lifecycle === "ready" || lifecycle === "busy"
        ? DaemonProtocolValidator.isCount(value.fileCount)
        : lifecycle === "starting"
          ? value.fileCount === undefined
          : value.fileCount === undefined || DaemonProtocolValidator.isCount(value.fileCount)) &&
      DaemonProtocolValidator.isCount(value.processRssBytes) &&
      DaemonProtocolValidator.isCount(value.hardProcessRssBytes) &&
      (value.workerHeapUsedBytes === undefined ||
        DaemonProtocolValidator.isCount(value.workerHeapUsedBytes)) &&
      DaemonProtocolValidator.isCount(value.workerGeneration) &&
      (lifecycle !== "busy" ||
        (DaemonProtocolValidator.isRecord(current) &&
          DaemonProtocolValidator.hasExactKeys(current, ["requestId", "command", "elapsedMs"]) &&
          DaemonRuntimeValues.isRequestId(current.requestId) &&
          DaemonRuntimeValues.isCommandName(current.command) &&
          DaemonProtocolValidator.isMetric(current.elapsedMs))) &&
      DaemonProtocolValidator.isCount(value.queued) &&
      (value.lastCompletedAgoMs === undefined ||
        DaemonProtocolValidator.isMetric(value.lastCompletedAgoMs)) &&
      DaemonProtocolValidator.isCount(value.spoolBytes)
    );
  }

  private static isProtocolVersion(value: unknown): boolean {
    return Number.isSafeInteger(value) && Number(value) >= 0;
  }

  private static isCount(value: unknown): boolean {
    return Number.isSafeInteger(value) && Number(value) >= 0;
  }

  private static isPositiveInteger(value: unknown): boolean {
    return Number.isSafeInteger(value) && Number(value) > 0;
  }

  private static isMetric(value: unknown): boolean {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
  }

  private static isRuntimeString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
  }

  private static isDigest(value: unknown): value is string {
    return typeof value === "string" && /^[a-f\d]{64}$/.test(value);
  }

  private static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private static hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return (
      actual.length === expected.length && actual.every((key, index) => key === expected[index])
    );
  }
}
