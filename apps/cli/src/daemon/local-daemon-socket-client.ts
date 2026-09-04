import { createConnection, type Socket } from "node:net";
import type { DaemonSocketClient, DaemonSocketConnection } from "./daemon-transport.js";

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

  constructor(private readonly socket: Socket) {
    socket.pause();
    socket.on("data", (bytes) => this.receive(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)));
    socket.once("end", () => this.finish());
    socket.once("close", () => this.finish());
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return this;
  }

  next(): Promise<IteratorResult<Uint8Array>> {
    const bytes = this.queuedBytes.shift();
    if (bytes !== undefined) return Promise.resolve({ done: false, value: bytes });
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => {
      this.pendingRead = { resolve, reject };
      this.socket.resume();
    });
  }

  write(frame: Uint8Array): void {
    this.socket.write(frame);
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
    if (this.ended) return;
    this.ended = true;
    const pendingRead = this.pendingRead;
    this.pendingRead = undefined;
    pendingRead?.resolve({ done: true, value: undefined });
  }

}

export class LocalDaemonSocketClient implements DaemonSocketClient {
  connect(endpoint: string): Promise<DaemonSocketConnection> {
    return new Promise((resolve) => {
      const socket = createConnection(endpoint);
      socket.once("connect", () => {
        resolve(new LocalDaemonSocketConnection(socket));
      });
    });
  }
}
