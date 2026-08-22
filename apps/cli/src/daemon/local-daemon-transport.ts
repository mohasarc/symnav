import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import type { DaemonRequest, DaemonResponse, DaemonServer } from "./daemon-protocol.js";

const DEFAULT_MAXIMUM_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

interface LocalDaemonTransportOptions {
  readonly maximumFrameBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly writeChunkSize?: number;
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
  constructor(private readonly server: Server) {}

  close(): Promise<void> {
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
  private readonly writeChunkSize: number | undefined;

  constructor(options: LocalDaemonTransportOptions = {}) {
    this.maximumFrameBytes = options.maximumFrameBytes ?? DEFAULT_MAXIMUM_FRAME_BYTES;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.writeChunkSize = options.writeChunkSize;
  }

  request(endpoint: string, request: DaemonRequest): Promise<DaemonResponse> {
    LocalDaemonTransport.assertRequest(request);
    return new Promise((resolve, reject) => {
      const decoder = new DaemonFrameDecoder(this.maximumFrameBytes);
      const socket = createConnection(endpoint);
      let settled = false;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      socket.setTimeout(this.requestTimeoutMs, () => fail(new Error("Daemon request timed out")));
      socket.once("error", fail);
      socket.once("connect", () => this.writeFrame(socket, request));
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
          fail(new Error("Daemon connection ended before a response"));
        } catch (error) {
          fail(error);
        }
      });
    });
  }

  async listen(
    endpoint: string,
    handler: (request: DaemonRequest) => Promise<DaemonResponse>,
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
    const server = createServer((socket) => this.serve(socket, handler));
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, () => resolve(new ListeningDaemonServer(server)));
    });
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
    handler: (request: DaemonRequest) => Promise<DaemonResponse>,
  ): void {
    const decoder = new DaemonFrameDecoder(this.maximumFrameBytes);
    let responses = Promise.resolve();
    socket.on("data", (bytes) => {
      try {
        for (const value of decoder.append(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes))) {
          LocalDaemonTransport.assertRequest(value);
          responses = responses.then(async () => {
            this.writeFrame(socket, await handler(value));
          }).catch(() => {
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
    const payload = Buffer.from(JSON.stringify(value), "utf8");
    if (payload.length > this.maximumFrameBytes) {
      throw new Error(`Daemon frame exceeds ${this.maximumFrameBytes} bytes`);
    }
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(payload.length);
    const frame = Buffer.concat([prefix, payload]);
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
    if (request.kind === "ping") {
      if (
        value.kind !== "pong" ||
        value.protocolVersion !== request.protocolVersion ||
        value.instanceId !== request.instanceId
      ) {
        throw new Error("Daemon pong does not match request protocol and instance");
      }
      return value;
    }
    if (request.kind === "execute") {
      if (value.kind !== "result" || value.requestId !== request.requestId) {
        throw new Error("Daemon result does not match request identifier");
      }
      return value;
    }
    if (request.kind === "stop") {
      if (value.kind !== "stopped" || value.instanceId !== request.instanceId) {
        throw new Error("Daemon stop response does not match instance");
      }
      return value;
    }
    if (request.kind === "identify") {
      if (
        value.kind !== "identity" ||
        value.instanceId !== request.instanceId ||
        value.processToken !== request.processToken
      ) {
        throw new Error("Daemon identity does not match process instance");
      }
      return value;
    }
    if (
      value.kind !== "terminating" ||
      value.instanceId !== request.instanceId ||
      value.processToken !== request.processToken
    ) {
      throw new Error("Daemon termination does not match process instance");
    }
    return value;
  }

  private static assertRequest(value: unknown): asserts value is DaemonRequest {
    if (!LocalDaemonTransport.isRecord(value) || typeof value.kind !== "string") {
      throw new Error("Malformed daemon request");
    }
    if (value.kind === "identify" || value.kind === "terminate") {
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
      value.kind !== "execute" ||
      typeof value.requestId !== "string" ||
      !LocalDaemonTransport.isExecutionRequest(value.request)
    ) {
      throw new Error("Malformed daemon execute request");
    }
  }

  private static assertResponse(value: unknown): asserts value is DaemonResponse {
    if (
      !LocalDaemonTransport.isRecord(value) ||
      typeof value.kind !== "string" ||
      !["pong", "identity", "terminating", "stopped", "result"].includes(value.kind)
    ) {
      throw new Error("Malformed daemon response");
    }
    if (
      value.kind === "result" &&
      (typeof value.requestId !== "string" ||
        !LocalDaemonTransport.isExecutionResult(value.result))
    ) {
      throw new Error("Malformed daemon result");
    }
    if (
      value.kind === "pong" &&
      (typeof value.protocolVersion !== "number" ||
        typeof value.instanceId !== "string" ||
        typeof value.symnavVersion !== "string")
    ) {
      throw new Error("Malformed daemon pong");
    }
    if (value.kind === "stopped" && typeof value.instanceId !== "string") {
      throw new Error("Malformed daemon stop response");
    }
    if (
      value.kind === "identity" &&
      (typeof value.instanceId !== "string" ||
        typeof value.processToken !== "string" ||
        !Number.isInteger(value.pid) ||
        typeof value.startedAt !== "number")
    ) {
      throw new Error("Malformed daemon identity");
    }
  }

  private static isExecutionResult(value: unknown): boolean {
    if (
      !LocalDaemonTransport.isRecord(value) ||
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

  private static isExecutionRequest(value: unknown): boolean {
    return (
      LocalDaemonTransport.isRecord(value) &&
      Array.isArray(value.argv) &&
      value.argv.every((arg) => typeof arg === "string") &&
      typeof value.cwd === "string" &&
      typeof value.telemetryEnabled === "boolean"
    );
  }

  private static isBase64(value: string): boolean {
    if (value.length % 4 !== 0) return false;
    return /^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(value);
  }

  private static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}
