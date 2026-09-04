import { createConnection, type Socket } from "node:net";
import type { DaemonSocketClient, DaemonSocketConnection } from "./daemon-transport.js";

interface LocalDaemonSocketClientOptions {
  readonly writeChunkSize?: number;
}

class LocalDaemonSocketConnection implements DaemonSocketConnection, AsyncIterable<Uint8Array> {
  readonly incoming: AsyncIterable<Uint8Array> = this;
  private readonly queuedBytes: Uint8Array[] = [];
  private pendingRead:
    | {
        readonly resolve: (result: IteratorResult<Uint8Array>) => void;
        readonly reject: (error: unknown) => void;
      }
    | undefined;
  private ended = false;
  private error: unknown;
  private readonly queuedWrites: Uint8Array[] = [];
  private waitingForDrain = false;

  constructor(
    private readonly socket: Socket,
    private readonly writeChunkSize: number | undefined,
  ) {
    socket.pause();
    socket.on("data", (bytes) => this.receive(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)));
    socket.once("end", () => this.finish());
    socket.once("close", () => this.finish());
    socket.once("error", (error) => this.fail(error));
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return this;
  }

  next(): Promise<IteratorResult<Uint8Array>> {
    const bytes = this.queuedBytes.shift();
    if (bytes !== undefined) return Promise.resolve({ done: false, value: bytes });
    if (this.error !== undefined) return Promise.reject(this.error);
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => {
      this.pendingRead = { resolve, reject };
      this.socket.resume();
    });
  }

  write(frame: Uint8Array): void {
    const chunkSize = this.writeChunkSize ?? frame.length;
    for (let offset = 0; offset < frame.length; offset += chunkSize) {
      this.queuedWrites.push(frame.subarray(offset, offset + chunkSize));
    }
    try {
      this.flushWrites();
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  disableTimeout(): void {
    this.socket.setTimeout(0);
  }

  end(): void {
    this.socket.end();
  }

  destroy(): void {
    this.socket.destroy();
  }

  timeout(error: Error): void {
    this.fail(error);
    this.socket.destroy();
  }

  private receive(bytes: Uint8Array): void {
    this.socket.pause();
    const pendingRead = this.pendingRead;
    if (pendingRead === undefined) {
      this.queuedBytes.push(bytes);
      return;
    }
    this.pendingRead = undefined;
    pendingRead.resolve({ done: false, value: bytes });
  }

  private finish(): void {
    if (this.ended || this.error !== undefined) return;
    this.ended = true;
    const pendingRead = this.pendingRead;
    this.pendingRead = undefined;
    pendingRead?.resolve({ done: true, value: undefined });
  }

  private fail(error: unknown): void {
    if (this.ended || this.error !== undefined) return;
    this.error = error;
    const pendingRead = this.pendingRead;
    this.pendingRead = undefined;
    pendingRead?.reject(error);
  }

  private flushWrites(): void {
    if (this.waitingForDrain || this.ended || this.error !== undefined) return;
    while (this.queuedWrites.length > 0) {
      const frame = this.queuedWrites.shift();
      if (frame === undefined) return;
      if (this.socket.write(frame)) continue;
      this.waitingForDrain = true;
      this.socket.once("drain", () => {
        this.waitingForDrain = false;
        this.flushWrites();
      });
      return;
    }
  }
}

export class LocalDaemonSocketClient implements DaemonSocketClient {
  constructor(private readonly options: LocalDaemonSocketClientOptions = {}) {}

  connect(endpoint: string, timeoutMs?: number): Promise<DaemonSocketConnection> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(endpoint);
      let connection: LocalDaemonSocketConnection | undefined;
      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(error);
      };
      if (timeoutMs !== undefined) {
        socket.setTimeout(timeoutMs, () => {
          const error = Object.assign(new Error("Daemon socket timed out"), {
            code: "ETIMEDOUT" as const,
          });
          if (connection === undefined) {
            fail(error);
            return;
          }
          connection.timeout(error);
        });
      }
      socket.once("error", fail);
      socket.once("connect", () => {
        if (settled) return;
        settled = true;
        socket.off("error", fail);
        connection = new LocalDaemonSocketConnection(socket, this.options.writeChunkSize);
        resolve(connection);
      });
    });
  }
}
