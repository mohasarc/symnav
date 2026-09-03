import { createHash } from "node:crypto";
import type { DaemonResultChunk } from "./daemon-protocol.js";

const BINARY_FRAME_FLAG = 0x80000000;
const FRAME_LENGTH_MASK = 0x7fffffff;
const BINARY_HEADER_LENGTH_BYTES = 4;

interface DaemonResultChunkHeader {
  readonly transferId: string;
  readonly requestId: string;
  readonly offset: number;
  readonly sequence: number;
  readonly stream: "stdout" | "stderr";
  readonly payloadLength: number;
  readonly sha256: string;
}

export class DaemonResultChunkCodec {
  static encode(chunk: DaemonResultChunk, maximumChunkRawBytes: number): Buffer {
    DaemonResultChunkCodec.assertChunk(chunk, maximumChunkRawBytes);
    const header: DaemonResultChunkHeader = {
      transferId: chunk.transferId,
      requestId: chunk.requestId,
      offset: chunk.offset,
      sequence: chunk.sequence,
      stream: chunk.stream,
      payloadLength: chunk.bytes.byteLength,
      sha256: createHash("sha256").update(chunk.bytes).digest("hex"),
    };
    const headerBytes = Buffer.from(JSON.stringify(header));
    const payloadLength =
      BINARY_HEADER_LENGTH_BYTES + headerBytes.byteLength + chunk.bytes.byteLength;
    const encoded = Buffer.alloc(4 + payloadLength);
    encoded.writeUInt32BE((BINARY_FRAME_FLAG | payloadLength) >>> 0, 0);
    encoded.writeUInt32BE(headerBytes.byteLength, 4);
    headerBytes.copy(encoded, 8);
    Buffer.from(chunk.bytes).copy(encoded, 8 + headerBytes.byteLength);
    return encoded;
  }

  static decode(payload: Buffer, maximumChunkRawBytes: number): DaemonResultChunk {
    if (payload.byteLength < BINARY_HEADER_LENGTH_BYTES) {
      throw new Error("Truncated daemon result chunk header");
    }
    const headerLength = payload.readUInt32BE(0);
    if (headerLength === 0 || headerLength > payload.byteLength - BINARY_HEADER_LENGTH_BYTES) {
      throw new Error("Invalid daemon result chunk header length");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.subarray(4, 4 + headerLength).toString("utf8"));
    } catch {
      throw new Error("Malformed daemon result chunk header");
    }
    const bytes = payload.subarray(4 + headerLength);
    if (
      !DaemonResultChunkCodec.isHeader(parsed, maximumChunkRawBytes) ||
      parsed.payloadLength !== bytes.byteLength
    ) {
      throw new Error("Invalid daemon result chunk header");
    }
    if (createHash("sha256").update(bytes).digest("hex") !== parsed.sha256) {
      throw new Error("Corrupt daemon result chunk payload");
    }
    const chunk: DaemonResultChunk = {
      transferId: parsed.transferId,
      requestId: parsed.requestId,
      offset: parsed.offset,
      sequence: parsed.sequence,
      stream: parsed.stream,
      bytes: Uint8Array.from(bytes),
    };
    DaemonResultChunkCodec.assertChunk(chunk, maximumChunkRawBytes);
    return chunk;
  }

  private static assertChunk(chunk: DaemonResultChunk, maximumChunkRawBytes: number): void {
    if (
      chunk.transferId.length === 0 ||
      chunk.requestId.length === 0 ||
      !Number.isSafeInteger(chunk.offset) ||
      chunk.offset < 0 ||
      !Number.isSafeInteger(chunk.sequence) ||
      chunk.sequence < 0 ||
      (chunk.stream !== "stdout" && chunk.stream !== "stderr") ||
      !(chunk.bytes instanceof Uint8Array) ||
      chunk.bytes.byteLength > maximumChunkRawBytes
    ) {
      throw new Error("Invalid daemon result chunk");
    }
  }

  private static isHeader(
    value: unknown,
    maximumChunkRawBytes: number,
  ): value is DaemonResultChunkHeader {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const header = value as Record<string, unknown>;
    const keys = Object.keys(header).sort();
    const expected = [
      "offset",
      "payloadLength",
      "requestId",
      "sequence",
      "sha256",
      "stream",
      "transferId",
    ].sort();
    return (
      keys.length === expected.length &&
      keys.every((key, index) => key === expected[index]) &&
      typeof header.transferId === "string" &&
      header.transferId.length > 0 &&
      typeof header.requestId === "string" &&
      header.requestId.length > 0 &&
      Number.isSafeInteger(header.offset) &&
      Number(header.offset) >= 0 &&
      Number.isSafeInteger(header.sequence) &&
      Number(header.sequence) >= 0 &&
      (header.stream === "stdout" || header.stream === "stderr") &&
      Number.isSafeInteger(header.payloadLength) &&
      Number(header.payloadLength) >= 0 &&
      Number(header.payloadLength) <= maximumChunkRawBytes &&
      typeof header.sha256 === "string" &&
      /^[a-f\d]{64}$/.test(header.sha256)
    );
  }
}

export class DaemonTransferFrameDecoder {
  private buffered = Buffer.alloc(0);

  constructor(
    private readonly maximumControlFrameBytes: number,
    private readonly maximumChunkRawBytes: number,
  ) {}

  append(bytes: Buffer): readonly (unknown | DaemonResultChunk)[] {
    this.buffered = Buffer.concat([this.buffered, bytes]);
    const values: (unknown | DaemonResultChunk)[] = [];
    while (this.buffered.byteLength >= 4) {
      const encodedLength = this.buffered.readUInt32BE(0);
      const binary = (encodedLength & BINARY_FRAME_FLAG) !== 0;
      const payloadLength = encodedLength & FRAME_LENGTH_MASK;
      const maximum = binary
        ? this.maximumControlFrameBytes + this.maximumChunkRawBytes
        : this.maximumControlFrameBytes;
      if (payloadLength > maximum) throw new Error("Daemon result frame exceeds capacity");
      if (this.buffered.byteLength < payloadLength + 4) break;
      const payload = this.buffered.subarray(4, payloadLength + 4);
      this.buffered = this.buffered.subarray(payloadLength + 4);
      if (binary) {
        values.push(DaemonResultChunkCodec.decode(payload, this.maximumChunkRawBytes));
        continue;
      }
      try {
        values.push(JSON.parse(payload.toString("utf8")));
      } catch {
        throw new Error("Daemon control frame contains malformed JSON");
      }
    }
    return values;
  }

  assertComplete(): void {
    if (this.buffered.byteLength !== 0) {
      throw new Error("Daemon result transfer ended with a truncated frame");
    }
  }
}
