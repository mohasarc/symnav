import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import type { DaemonPolicyValues } from "@symnav/daemon";
import type { DaemonServer, DaemonServerMessage } from "./daemon-protocol.js";
import type {
  DaemonRequestHandler,
  DaemonRequestServer,
  DaemonServerSend,
  DaemonSocketClient,
} from "./daemon-transport.js";
import type { DaemonProtocolValidator } from "./daemon-protocol-validator.js";
import type { DaemonWireCodec } from "./daemon-wire-codec.js";

interface LocalDaemonSocketServerOptions {
  readonly sockets: DaemonSocketClient;
  readonly codec: DaemonWireCodec;
  readonly validator: DaemonProtocolValidator;
  readonly policy: DaemonPolicyValues["transport"];
  readonly writeChunkSize?: number;
}

class ListeningDaemonServer implements DaemonServer {
  private closing: Promise<void> | undefined;

  constructor(
    private readonly server: Server,
    private readonly sockets: ReadonlySet<Socket>,
  ) {}

  close(force = false): Promise<void> {
    if (force) {
      for (const socket of this.sockets) socket.destroy();
    }
    if (this.closing !== undefined) return this.closing;
    if (!this.server.listening) return Promise.resolve();
    this.closing = new Promise((resolve, reject) => {
      this.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    return this.closing;
  }
}

export class LocalDaemonSocketServer implements DaemonRequestServer {
  constructor(private readonly options: LocalDaemonSocketServerOptions) {}

  async listen(endpoint: string, handler: DaemonRequestHandler): Promise<DaemonServer> {
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

  private async endpointIsReachable(endpoint: string): Promise<boolean> {
    try {
      const connection = await this.options.sockets.connect(
        endpoint,
        this.options.policy.singleResponseTimeoutMs,
      );
      connection.destroy();
      return true;
    } catch {
      return false;
    }
  }

  private serve(socket: Socket, handler: DaemonRequestHandler): void {
    const decoder = this.options.codec.controlDecoder();
    let responses = Promise.resolve();
    let writes = Promise.resolve();
    const closeListeners = new Set<() => void>();
    const send: DaemonServerSend = Object.assign(
      (message: DaemonServerMessage) => {
        const write = writes.then(() => this.writeServerMessage(socket, message));
        writes = write;
        return write;
      },
      {
        onClose: (listener: () => void): (() => void) => {
          closeListeners.add(listener);
          return () => closeListeners.delete(listener);
        },
      },
    );
    socket.on("data", (bytes) => {
      try {
        for (const value of decoder.append(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes))) {
          const request = this.options.validator.request(value);
          responses = responses
            .then(async () => {
              const response = await handler(request, send);
              if (response !== undefined) await send(response);
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
    socket.once("close", () => {
      for (const listener of closeListeners) {
        try {
          listener();
        } catch {}
      }
      closeListeners.clear();
    });
    socket.once("error", () => socket.destroy());
  }

  private async writeServerMessage(socket: Socket, message: DaemonServerMessage): Promise<void> {
    await this.writeEncodedServerFrame(socket, this.options.codec.encodeServerMessage(message));
  }

  private async writeEncodedServerFrame(socket: Socket, frame: Uint8Array): Promise<void> {
    const chunkSize = this.options.writeChunkSize ?? frame.length;
    for (let offset = 0; offset < frame.length; offset += chunkSize) {
      if (socket.destroyed) throw new Error("Daemon socket closed during response delivery");
      const accepted = socket.write(frame.subarray(offset, offset + chunkSize));
      if (!accepted) await LocalDaemonSocketServer.waitForDrain(socket);
    }
  }

  private static waitForDrain(socket: Socket): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        socket.off("drain", drained);
        socket.off("error", failed);
        socket.off("close", closed);
      };
      const drained = (): void => {
        cleanup();
        resolve();
      };
      const failed = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const closed = (): void => {
        cleanup();
        reject(new Error("Daemon socket closed during response delivery"));
      };
      socket.once("drain", drained);
      socket.once("error", failed);
      socket.once("close", closed);
    });
  }
}
