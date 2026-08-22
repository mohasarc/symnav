import type { Server } from "node:net";
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

  constructor(_maximumFrameBytes: number) {}

  append(_bytes: Buffer): readonly unknown[] {
    throw new Error("Daemon frame decoding is not implemented");
  }

  assertComplete(): void {}
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

  request(_endpoint: string, _request: DaemonRequest): Promise<DaemonResponse> {
    throw new Error("Local daemon requests are not implemented");
  }

  async listen(
    _endpoint: string,
    _handler: (request: DaemonRequest) => Promise<DaemonResponse>,
  ): Promise<DaemonServer> {
    throw new Error("Local daemon servers are not implemented");
  }
}
