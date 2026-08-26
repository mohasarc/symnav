import type { DaemonResultChunk } from "./daemon-protocol.js";

export class DaemonResultChunkCodec {
  static encode(_chunk: DaemonResultChunk): Buffer {
    throw new Error("Daemon result chunk codec is not implemented");
  }
}

export class DaemonTransferFrameDecoder {
  constructor(_maximumControlFrameBytes: number) {}

  append(_bytes: Buffer): readonly (unknown | DaemonResultChunk)[] {
    throw new Error("Daemon transfer frame decoder is not implemented");
  }

  assertComplete(): void {
    throw new Error("Daemon transfer frame decoder is not implemented");
  }
}
