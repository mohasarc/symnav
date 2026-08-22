import { createConnection, createServer, type Server, type Socket } from "node:net";
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
          const value = decoder.append(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes))[0];
          if (value === undefined) return;
          const response = LocalDaemonTransport.responseFor(value);
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
    const server = createServer((socket) => this.serve(socket, handler));
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, () => resolve(new ListeningDaemonServer(server)));
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
          responses = responses.then(async () => {
            this.writeFrame(socket, await handler(value as DaemonRequest));
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

  private static responseFor(value: unknown): DaemonResponse {
    LocalDaemonTransport.assertResponse(value);
    return value;
  }

  private static assertResponse(value: unknown): asserts value is DaemonResponse {
    if (
      !LocalDaemonTransport.isRecord(value) ||
      typeof value.kind !== "string" ||
      !["pong", "identity", "terminating", "stopped", "result"].includes(value.kind)
    ) {
      throw new Error("Malformed daemon response");
    }
  }

  private static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}
