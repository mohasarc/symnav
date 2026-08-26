import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import type { CommandExecutionResult } from "../command-execution-result.js";
import type {
  DaemonExecuteRequest,
  DaemonExecutionFailureCode,
  DaemonExecutionServerFrame,
  DaemonExecutionStatus,
  DaemonExecutionStatusRequest,
  DaemonRequest,
  DaemonResponse,
  DaemonServer,
} from "./daemon-protocol.js";

const DEFAULT_MAXIMUM_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 250;
const DEFAULT_EXECUTION_REQUEST_TIMEOUT_MS = 5 * 60_000;

interface LocalDaemonTransportOptions {
  readonly maximumFrameBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly executionRequestTimeoutMs?: number;
  readonly writeChunkSize?: number;
}

export type DaemonDeliveryState = "not-submitted" | "submitted-unconfirmed" | "accepted";

export type DaemonTransportFailureCode =
  | "unreachable"
  | "timeout"
  | "corrupt"
  | "incompatible"
  | "authentication"
  | "closed"
  | "rejected";

export interface DaemonExecutionAcceptance {
  readonly requestId: string;
  readonly instanceId: string;
  readonly acceptedAt: number;
  readonly queuePosition: number;
}

export interface DaemonExecutionReceipt {
  readonly acceptance: DaemonExecutionAcceptance;
  readonly completion: Promise<
    | { readonly status: "completed"; readonly result: CommandExecutionResult }
    | { readonly status: "failed"; readonly code: DaemonExecutionFailureCode }
  >;
}

export class DaemonTransportError extends Error {
  readonly authenticatedInstanceId?: string;
  readonly retrySafe: boolean;

  constructor(
    readonly code: DaemonTransportFailureCode,
    readonly delivery: DaemonDeliveryState,
    message: string,
    authenticatedInstanceId?: string,
    retrySafe = delivery === "not-submitted",
  ) {
    super(message);
    this.name = "DaemonTransportError";
    if (authenticatedInstanceId !== undefined) {
      this.authenticatedInstanceId = authenticatedInstanceId;
    }
    this.retrySafe = retrySafe;
  }
}

class DaemonResponseError extends Error {
  constructor(
    readonly code: Extract<
      DaemonTransportFailureCode,
      "authentication" | "corrupt" | "incompatible"
    >,
    message: string,
    readonly authenticatedInstanceId?: string,
  ) {
    super(message);
  }
}

class DaemonFrameDecoder {
  private buffered = Buffer.alloc(0);

  constructor(private readonly maximumFrameBytes: number) {}

  append(bytes: Buffer): readonly unknown[] {
    this.buffered = Buffer.concat([this.buffered, bytes]);
    const values: unknown[] = [];
    while (this.buffered.length >= 4) {
      const payloadLength = this.buffered.readUInt32BE(0);
      if (payloadLength > this.maximumFrameBytes) {
        throw new Error(`Daemon frame exceeds ${this.maximumFrameBytes} bytes`);
      }
      if (this.buffered.length < payloadLength + 4) break;
      const payload = this.buffered.subarray(4, payloadLength + 4);
      this.buffered = this.buffered.subarray(payloadLength + 4);
      try {
        values.push(JSON.parse(payload.toString("utf8")));
      } catch {
        throw new Error("Daemon frame contains malformed JSON");
      }
    }
    return values;
  }

  assertComplete(): void {
    if (this.buffered.length !== 0) {
      throw new Error("Daemon connection ended with a truncated frame");
    }
  }
}

class ListeningDaemonServer implements DaemonServer {
  constructor(
    private readonly server: Server,
    private readonly sockets: ReadonlySet<Socket>,
  ) {}

  close(force = false): Promise<void> {
    if (force) {
      for (const socket of this.sockets) socket.destroy();
    }
    if (!this.server.listening) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

export class LocalDaemonTransport {
  private readonly maximumFrameBytes: number;
  private readonly requestTimeoutMs: number;
  private readonly executionRequestTimeoutMs: number;
  private readonly writeChunkSize: number | undefined;

  constructor(options: LocalDaemonTransportOptions = {}) {
    this.maximumFrameBytes = options.maximumFrameBytes ?? DEFAULT_MAXIMUM_FRAME_BYTES;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.executionRequestTimeoutMs =
      options.executionRequestTimeoutMs ?? DEFAULT_EXECUTION_REQUEST_TIMEOUT_MS;
    this.writeChunkSize = options.writeChunkSize;
  }

  canFrame(value: unknown): boolean {
    try {
      this.encodeFrame(value);
      return true;
    } catch {
      return false;
    }
  }

  request(endpoint: string, request: DaemonRequest): Promise<DaemonResponse> {
    LocalDaemonTransport.assertRequest(request);
    return new Promise((resolve, reject) => {
      const decoder = new DaemonFrameDecoder(this.maximumFrameBytes);
      const socket = createConnection(endpoint);
      let settled = false;
      let delivery: DaemonDeliveryState = "not-submitted";
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(LocalDaemonTransport.transportError(error, delivery));
      };
      socket.setTimeout(this.timeoutFor(request), () =>
        fail(new DaemonTransportError("timeout", delivery, "Daemon request timed out")),
      );
      socket.once("error", (error) => {
        if (delivery === "not-submitted") {
          fail(new DaemonTransportError("unreachable", delivery, error.message));
          return;
        }
        fail(new DaemonTransportError("closed", delivery, error.message));
      });
      socket.once("connect", () => {
        try {
          this.writeFrame(socket, request);
          delivery = "submitted-unconfirmed";
        } catch (error) {
          fail(error);
        }
      });
      socket.on("data", (bytes) => {
        try {
          const values = decoder.append(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
          if (values.length > 1 || (values.length === 1 && settled)) {
            fail(new Error("Daemon returned multiple responses"));
            return;
          }
          const value = values[0];
          if (value === undefined) return;
          const response = LocalDaemonTransport.responseFor(request, value);
          delivery = "accepted";
          settled = true;
          socket.end();
          resolve(response);
        } catch (error) {
          fail(error);
        }
      });
      socket.once("end", () => {
        if (settled) return;
        try {
          decoder.assertComplete();
          fail(
            new DaemonTransportError(
              "closed",
              delivery,
              "Daemon connection ended before a response",
            ),
          );
        } catch (error) {
          fail(error);
        }
      });
    });
  }

  execute(endpoint: string, request: DaemonExecuteRequest): Promise<DaemonExecutionReceipt> {
    LocalDaemonTransport.assertRequest(request);
    return new Promise((resolve, reject) => {
      const decoder = new DaemonFrameDecoder(this.maximumFrameBytes);
      const socket = createConnection(endpoint);
      let delivery: DaemonDeliveryState = "not-submitted";
      let acceptance: DaemonExecutionAcceptance | undefined;
      let terminal = false;
      let outerSettled = false;
      let completionSettled = false;
      let resolveCompletion!: (value: Awaited<DaemonExecutionReceipt["completion"]>) => void;
      let rejectCompletion!: (error: DaemonTransportError) => void;
      const completion = new Promise<Awaited<DaemonExecutionReceipt["completion"]>>(
        (completionResolve, completionReject) => {
          resolveCompletion = completionResolve;
          rejectCompletion = completionReject;
        },
      );
      const fail = (error: unknown): void => {
        const transportError = LocalDaemonTransport.transportError(error, delivery);
        socket.destroy();
        if (!outerSettled) {
          outerSettled = true;
          reject(transportError);
          return;
        }
        if (!completionSettled) {
          completionSettled = true;
          rejectCompletion(transportError);
        }
      };
      socket.setTimeout(this.requestTimeoutMs, () =>
        fail(new DaemonTransportError("timeout", delivery, "Daemon request timed out")),
      );
      socket.once("error", (error) => {
        fail(
          new DaemonTransportError(
            delivery === "not-submitted" ? "unreachable" : "closed",
            delivery,
            error.message,
            acceptance?.instanceId,
          ),
        );
      });
      socket.once("connect", () => {
        try {
          const encoded = this.encodeFrame(request);
          delivery = "submitted-unconfirmed";
          this.writeEncodedFrame(socket, encoded);
        } catch (error) {
          fail(error);
        }
      });
      socket.on("data", (bytes) => {
        try {
          const values = decoder.append(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
          let terminalValue: Awaited<DaemonExecutionReceipt["completion"]> | undefined;
          for (const value of values) {
            const frame = LocalDaemonTransport.executionFrameFor(request, value);
            if (frame.kind === "rejected") {
              if (acceptance !== undefined || terminal) {
                throw new Error("Daemon rejected an already accepted request");
              }
              throw new DaemonTransportError(
                "rejected",
                "submitted-unconfirmed",
                `Daemon rejected execution: ${frame.code}`,
                frame.instanceId,
                frame.retrySafe,
              );
            }
            if (frame.kind === "accepted") {
              if (acceptance !== undefined || terminal) {
                throw new Error("Daemon returned duplicate acceptance");
              }
              delivery = "accepted";
              acceptance = {
                requestId: frame.requestId,
                instanceId: frame.instanceId,
                acceptedAt: frame.acceptedAt,
                queuePosition: frame.queuePosition,
              };
              continue;
            }
            if (acceptance === undefined) {
              throw new Error("Daemon returned completion before acceptance");
            }
            if (terminal) throw new Error("Daemon returned duplicate terminal frame");
            terminal = true;
            terminalValue =
              frame.kind === "completed"
                ? { status: "completed", result: frame.result }
                : { status: "failed", code: frame.code };
          }
          if (acceptance !== undefined && !outerSettled) {
            outerSettled = true;
            socket.setTimeout(0);
            resolve({ acceptance, completion });
          }
          if (terminalValue !== undefined && !completionSettled) {
            completionSettled = true;
            socket.end();
            resolveCompletion(terminalValue);
          }
        } catch (error) {
          fail(error);
        }
      });
      socket.once("end", () => {
        if (terminal && completionSettled) return;
        try {
          decoder.assertComplete();
          fail(
            new DaemonTransportError(
              "closed",
              delivery,
              acceptance === undefined
                ? "Daemon connection ended before acceptance"
                : "Daemon connection ended after acceptance before completion",
              acceptance?.instanceId,
            ),
          );
        } catch (error) {
          fail(error);
        }
      });
    });
  }

  async executionStatus(
    endpoint: string,
    request: DaemonExecutionStatusRequest,
  ): Promise<DaemonExecutionStatus> {
    const response = await this.request(endpoint, request);
    if (response.kind !== "execution-status") {
      throw new DaemonTransportError(
        "corrupt",
        "accepted",
        "Daemon returned a non-status response",
      );
    }
    return response.status;
  }

  private timeoutFor(request: DaemonRequest): number {
    return request.kind === "execute" ? this.executionRequestTimeoutMs : this.requestTimeoutMs;
  }

  async listen(
    endpoint: string,
    handler: (
      request: DaemonRequest,
      send: (response: DaemonResponse) => void,
    ) => Promise<DaemonResponse | void>,
  ): Promise<DaemonServer> {
    if (process.platform !== "win32") {
      mkdirSync(dirname(endpoint), { recursive: true, mode: 0o700 });
      if (existsSync(endpoint)) {
        if (await this.endpointIsReachable(endpoint)) {
          throw new Error(`Daemon endpoint is already in use: ${endpoint}`);
        }
        rmSync(endpoint, { force: true });
      }
    }
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      this.serve(socket, handler);
    });
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, () => resolve(new ListeningDaemonServer(server, sockets)));
    });
  }

  async removeUnavailableEndpoint(endpoint: string): Promise<boolean> {
    if (await this.endpointIsReachable(endpoint)) return false;
    if (process.platform !== "win32") rmSync(endpoint, { force: true });
    return true;
  }

  private endpointIsReachable(endpoint: string): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = createConnection(endpoint);
      const finish = (reachable: boolean): void => {
        socket.destroy();
        resolve(reachable);
      };
      socket.setTimeout(this.requestTimeoutMs, () => finish(false));
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
    });
  }

  private serve(
    socket: Socket,
    handler: (
      request: DaemonRequest,
      send: (response: DaemonResponse) => void,
    ) => Promise<DaemonResponse | void>,
  ): void {
    const decoder = new DaemonFrameDecoder(this.maximumFrameBytes);
    let responses = Promise.resolve();
    socket.on("data", (bytes) => {
      try {
        for (const value of decoder.append(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes))) {
          LocalDaemonTransport.assertRequest(value);
          responses = responses
            .then(async () => {
              const response = await handler(value, (serverFrame) => {
                if (!socket.destroyed) this.writeFrame(socket, serverFrame);
              });
              if (response !== undefined && !socket.destroyed) this.writeFrame(socket, response);
            })
            .catch(() => {
              socket.destroy();
            });
        }
      } catch {
        socket.destroy();
      }
    });
    socket.once("end", () => {
      try {
        decoder.assertComplete();
      } catch {
        socket.destroy();
      }
    });
    socket.once("error", () => socket.destroy());
  }

  private writeFrame(socket: Socket, value: unknown): void {
    this.writeEncodedFrame(socket, this.encodeFrame(value));
  }

  private encodeFrame(value: unknown): Buffer {
    const payload = Buffer.from(JSON.stringify(value), "utf8");
    if (payload.length > this.maximumFrameBytes) {
      throw new Error(`Daemon frame exceeds ${this.maximumFrameBytes} bytes`);
    }
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(payload.length);
    return Buffer.concat([prefix, payload]);
  }

  private writeEncodedFrame(socket: Pick<Socket, "write">, frame: Buffer): void {
    if (this.writeChunkSize === undefined) {
      socket.write(frame);
      return;
    }
    for (let offset = 0; offset < frame.length; offset += this.writeChunkSize) {
      socket.write(frame.subarray(offset, offset + this.writeChunkSize));
    }
  }

  private static responseFor(request: DaemonRequest, value: unknown): DaemonResponse {
    LocalDaemonTransport.assertResponse(value);
    if (request.kind === "identify") {
      if (value.kind !== "identity") {
        throw new DaemonResponseError("corrupt", "Daemon returned a non-identity response");
      }
      if (value.instanceId !== request.instanceId || value.processToken !== request.processToken) {
        throw new DaemonResponseError(
          "authentication",
          "Daemon identity does not match process instance",
          value.instanceId === request.instanceId ? value.instanceId : undefined,
        );
      }
      return value;
    }
    if (request.kind === "terminate" || request.kind === "kill") {
      const expectedKind = request.kind === "terminate" ? "terminating" : "killing";
      if (value.kind !== expectedKind) {
        throw new DaemonResponseError("corrupt", "Daemon returned a non-termination response");
      }
      if (value.instanceId !== request.instanceId || value.processToken !== request.processToken) {
        throw new DaemonResponseError(
          "authentication",
          "Daemon termination does not match process instance",
          value.instanceId === request.instanceId ? value.instanceId : undefined,
        );
      }
      return value;
    }
    if (request.kind === "ping") {
      if (value.kind !== "pong") {
        throw new DaemonResponseError(
          "corrupt",
          "Daemon pong does not match request protocol and instance",
        );
      }
      if (value.instanceId !== request.instanceId) {
        throw new DaemonResponseError(
          "authentication",
          "Daemon pong does not match request instance",
        );
      }
      if (value.protocolVersion !== request.protocolVersion) {
        throw new DaemonResponseError(
          "incompatible",
          "Daemon pong does not match request protocol",
          value.instanceId,
        );
      }
      return value;
    }
    if (request.kind === "execute") {
      if (value.kind !== "result") {
        throw new DaemonResponseError("corrupt", "Daemon returned a non-result response");
      }
      if (value.requestId !== request.requestId) {
        throw new DaemonResponseError("corrupt", "Daemon result does not match request identifier");
      }
      return value;
    }
    if (request.kind === "execution-status") {
      if (value.kind !== "execution-status") {
        throw new DaemonResponseError("corrupt", "Daemon returned a non-status response");
      }
      LocalDaemonTransport.assertExecutionCoordinates(request, value);
      return value;
    }
    if (value.kind !== "stopped") {
      throw new DaemonResponseError("corrupt", "Daemon returned a non-stop response");
    }
    if (value.instanceId !== request.instanceId) {
      throw new DaemonResponseError(
        "authentication",
        "Daemon stop response does not match instance",
      );
    }
    return value;
  }

  private static assertRequest(value: unknown): asserts value is DaemonRequest {
    if (!LocalDaemonTransport.isRecord(value) || typeof value.kind !== "string") {
      throw new Error("Malformed daemon request");
    }
    if (value.kind === "identify" || value.kind === "terminate" || value.kind === "kill") {
      if (typeof value.instanceId !== "string" || typeof value.processToken !== "string") {
        throw new Error("Malformed daemon identity request");
      }
      return;
    }
    if (typeof value.protocolVersion !== "number" || typeof value.instanceId !== "string") {
      throw new Error("Malformed daemon request envelope");
    }
    if (value.kind === "ping" || value.kind === "stop") return;
    if (
      (value.kind !== "execute" && value.kind !== "execution-status") ||
      typeof value.processToken !== "string" ||
      typeof value.requestId !== "string" ||
      (value.kind === "execute" && !LocalDaemonTransport.isExecutionRequest(value.request))
    ) {
      throw new Error("Malformed daemon execution request");
    }
  }

  private static assertResponse(value: unknown): asserts value is DaemonResponse {
    if (!LocalDaemonTransport.isRecord(value) || typeof value.kind !== "string") {
      throw new Error("Malformed daemon response");
    }
    if (value.kind === "pong") {
      if (
        typeof value.protocolVersion !== "number" ||
        typeof value.instanceId !== "string" ||
        typeof value.symnavVersion !== "string" ||
        (value.state !== undefined &&
          value.state !== "starting" &&
          value.state !== "ready" &&
          value.state !== "busy") ||
        (value.startedAt !== undefined && typeof value.startedAt !== "number") ||
        (value.fileCount !== undefined && typeof value.fileCount !== "number") ||
        (value.memoryBytes !== undefined && typeof value.memoryBytes !== "number") ||
        (value.lastNavigationAt !== undefined && typeof value.lastNavigationAt !== "number") ||
        (value.currentCommand !== undefined && typeof value.currentCommand !== "string") ||
        (value.currentCommandElapsedMs !== undefined &&
          typeof value.currentCommandElapsedMs !== "number") ||
        (value.queued !== undefined && typeof value.queued !== "number")
      ) {
        throw new Error("Malformed daemon pong");
      }
      return;
    }
    if (value.kind === "identity") {
      if (
        typeof value.instanceId !== "string" ||
        typeof value.processToken !== "string" ||
        !Number.isInteger(value.pid) ||
        typeof value.startedAt !== "number"
      ) {
        throw new Error("Malformed daemon identity");
      }
      return;
    }
    if (value.kind === "terminating" || value.kind === "killing") {
      if (typeof value.instanceId !== "string" || typeof value.processToken !== "string") {
        throw new Error("Malformed daemon termination response");
      }
      return;
    }
    if (value.kind === "stopped") {
      if (typeof value.instanceId !== "string") throw new Error("Malformed daemon stop response");
      return;
    }
    if (
      value.kind === "accepted" ||
      value.kind === "rejected" ||
      value.kind === "completed" ||
      value.kind === "execution-failed"
    ) {
      LocalDaemonTransport.assertExecutionFrame(value);
      return;
    }
    if (value.kind === "execution-status") {
      if (
        typeof value.instanceId !== "string" ||
        typeof value.processToken !== "string" ||
        typeof value.requestId !== "string" ||
        !LocalDaemonTransport.isExecutionStatus(value.status)
      ) {
        throw new Error("Malformed daemon execution status");
      }
      return;
    }
    if (
      value.kind !== "result" ||
      typeof value.requestId !== "string" ||
      !LocalDaemonTransport.isExecutionResult(value.result)
    ) {
      throw new Error("Malformed daemon result");
    }
  }

  private static transportError(
    error: unknown,
    delivery: DaemonDeliveryState,
  ): DaemonTransportError {
    if (error instanceof DaemonTransportError) return error;
    if (error instanceof DaemonResponseError) {
      return new DaemonTransportError(
        error.code,
        "accepted",
        error.message,
        error.authenticatedInstanceId,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return new DaemonTransportError("corrupt", delivery, message);
  }

  private static executionFrameFor(
    request: DaemonExecuteRequest,
    value: unknown,
  ): DaemonExecutionServerFrame {
    LocalDaemonTransport.assertResponse(value);
    if (
      value.kind !== "accepted" &&
      value.kind !== "rejected" &&
      value.kind !== "completed" &&
      value.kind !== "execution-failed"
    ) {
      throw new DaemonResponseError("corrupt", "Daemon returned a non-execution frame");
    }
    LocalDaemonTransport.assertExecutionCoordinates(request, value);
    return value;
  }

  private static assertExecutionCoordinates(
    request: Pick<DaemonExecuteRequest, "instanceId" | "processToken" | "requestId">,
    response: Pick<DaemonExecutionServerFrame, "instanceId" | "processToken" | "requestId">,
  ): void {
    if (response.instanceId !== request.instanceId) {
      throw new DaemonResponseError("authentication", "Daemon execution instance does not match");
    }
    if (response.processToken !== request.processToken) {
      throw new DaemonResponseError(
        "authentication",
        "Daemon execution process token does not match",
        response.instanceId,
      );
    }
    if (response.requestId !== request.requestId) {
      throw new DaemonResponseError(
        "corrupt",
        "Daemon execution request identifier does not match",
        response.instanceId,
      );
    }
  }

  private static assertExecutionFrame(
    value: Record<string, unknown>,
  ): asserts value is DaemonExecutionServerFrame {
    if (
      typeof value.instanceId !== "string" ||
      typeof value.processToken !== "string" ||
      typeof value.requestId !== "string"
    ) {
      throw new Error("Malformed daemon execution frame");
    }
    if (value.kind === "accepted") {
      if (
        !LocalDaemonTransport.isMetric(value.acceptedAt) ||
        !LocalDaemonTransport.isCount(value.queuePosition)
      ) {
        throw new Error("Malformed daemon acceptance");
      }
      return;
    }
    if (value.kind === "rejected") {
      if (
        !LocalDaemonTransport.isExecuteRejectionCode(value.code) ||
        typeof value.retrySafe !== "boolean"
      ) {
        throw new Error("Malformed daemon execution rejection");
      }
      return;
    }
    if (value.kind === "completed") {
      if (!LocalDaemonTransport.isExecutionResult(value.result)) {
        throw new Error("Malformed daemon execution completion");
      }
      return;
    }
    if (!LocalDaemonTransport.isExecutionFailureCode(value.code)) {
      throw new Error("Malformed daemon execution failure");
    }
  }

  private static isExecuteRejectionCode(value: unknown): boolean {
    return (
      value === "not-ready" ||
      value === "draining" ||
      value === "resource-pressure" ||
      value === "incompatible"
    );
  }

  private static isExecutionFailureCode(value: unknown): value is DaemonExecutionFailureCode {
    return (
      value === "worker-exit" ||
      value === "controlled-resource" ||
      value === "response-capacity" ||
      value === "stopping" ||
      value === "internal"
    );
  }

  private static isExecutionStatus(value: unknown): value is DaemonExecutionStatus {
    if (!LocalDaemonTransport.isRecord(value)) return false;
    if (value.state === "unknown" || value.state === "completed") return true;
    if (value.state === "queued") return LocalDaemonTransport.isCount(value.queuePosition);
    if (value.state === "running") return LocalDaemonTransport.isMetric(value.startedAt);
    return value.state === "failed" && LocalDaemonTransport.isExecutionFailureCode(value.code);
  }

  private static isCount(value: unknown): boolean {
    return Number.isInteger(value) && (value as number) >= 0;
  }

  private static isMetric(value: unknown): boolean {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
  }

  private static isExecutionRequest(value: unknown): boolean {
    if (!LocalDaemonTransport.isRecord(value)) return false;
    const expectedKeys = ["argv", "cwd", "telemetryEnabled"];
    if (value.executionMode !== undefined) expectedKeys.push("executionMode");
    return (
      LocalDaemonTransport.hasExactKeys(value, expectedKeys) &&
      Array.isArray(value.argv) &&
      value.argv.every((arg) => typeof arg === "string") &&
      typeof value.cwd === "string" &&
      typeof value.telemetryEnabled === "boolean" &&
      (value.executionMode === undefined ||
        value.executionMode === "cold" ||
        value.executionMode === "warm" ||
        value.executionMode === "fallback")
    );
  }

  private static isExecutionResult(value: unknown): boolean {
    if (
      !LocalDaemonTransport.isRecord(value) ||
      !LocalDaemonTransport.hasExactKeys(value, ["frames", "exitCode"]) ||
      !Array.isArray(value.frames) ||
      !Number.isInteger(value.exitCode)
    )
      return false;
    return value.frames.every(
      (frame) =>
        LocalDaemonTransport.isRecord(frame) &&
        (frame.stream === "stdout" || frame.stream === "stderr") &&
        typeof frame.bytesBase64 === "string" &&
        LocalDaemonTransport.isBase64(frame.bytesBase64),
    );
  }

  private static isBase64(value: string): boolean {
    if (value.length % 4 !== 0) return false;
    return /^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(value);
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
