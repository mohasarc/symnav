import { createHash } from "node:crypto";
import type { DaemonResultChunk, DaemonServerMessage } from "./daemon-protocol.js";

const BINARY_FRAME_FLAG = 0x80000000;
const FRAME_LENGTH_MASK = 0x7fffffff;
const FRAME_PREFIX_BYTES = 4;
const BINARY_HEADER_LENGTH_BYTES = 4;

export interface DaemonFrameDecoder<Frame> {
  append(bytes: Uint8Array): readonly Frame[];
  assertComplete(): void;
}

export interface DaemonWireLimits {
  readonly maximumJsonPayloadBytes: number;
  readonly maximumExecutionControlPayloadBytes: number;
  readonly maximumChunkRawBytes: number;
}

interface DaemonResultChunkHeader {
  readonly transferId: string;
  readonly requestId: string;
  readonly offset: number;
  readonly sequence: number;
  readonly stream: "stdout" | "stderr";
  readonly payloadLength: number;
  readonly sha256: string;
}

export class DaemonWireCodec {
  constructor(private readonly limits: DaemonWireLimits) {}

  encodeControl(value: unknown): Uint8Array {
    return this.encodeJson(value, this.limits.maximumJsonPayloadBytes);
  }

  encodeServerMessage(message: DaemonServerMessage): Uint8Array {
    if ("kind" in message) {
      return this.encodeJson(message, this.limits.maximumExecutionControlPayloadBytes);
    }
    return DaemonResultChunkCodec.encode(message, this.limits);
  }

  controlDecoder(): DaemonFrameDecoder<unknown> {
    return new DaemonControlFrameDecoder(this.limits.maximumJsonPayloadBytes);
  }

  transferDecoder(): DaemonFrameDecoder<unknown | DaemonResultChunk> {
    return new DaemonTransferFrameDecoder(this.limits);
  }

  private encodeJson(value: unknown, maximumPayloadBytes: number): Uint8Array {
    const payload = Buffer.from(JSON.stringify(value), "utf8");
    if (payload.byteLength > maximumPayloadBytes) {
      throw new Error(`Daemon frame exceeds ${maximumPayloadBytes} bytes`);
    }
    const prefix = Buffer.alloc(FRAME_PREFIX_BYTES);
    prefix.writeUInt32BE(payload.byteLength);
    return Buffer.concat([prefix, payload]);
  }
}

class DaemonControlFrameDecoder implements DaemonFrameDecoder<unknown> {
  private buffered = Buffer.alloc(0);

  constructor(private readonly maximumPayloadBytes: number) {}

  append(bytes: Uint8Array): readonly unknown[] {
    this.buffered = Buffer.concat([this.buffered, bytes]);
    const values: unknown[] = [];
    while (this.buffered.byteLength >= FRAME_PREFIX_BYTES) {
      const payloadLength = this.buffered.readUInt32BE(0);
      if (payloadLength > this.maximumPayloadBytes) {
        throw new Error(`Daemon frame exceeds ${this.maximumPayloadBytes} bytes`);
      }
      if (this.buffered.byteLength < payloadLength + FRAME_PREFIX_BYTES) break;
      const payload = this.buffered.subarray(
        FRAME_PREFIX_BYTES,
        payloadLength + FRAME_PREFIX_BYTES,
      );
      this.buffered = this.buffered.subarray(payloadLength + FRAME_PREFIX_BYTES);
      try {
        values.push(JSON.parse(payload.toString("utf8")));
      } catch {
        throw new Error("Daemon frame contains malformed JSON");
      }
    }
    return values;
  }

  assertComplete(): void {
    if (this.buffered.byteLength !== 0) {
      throw new Error("Daemon connection ended with a truncated frame");
    }
  }
}

class DaemonTransferFrameDecoder implements DaemonFrameDecoder<unknown | DaemonResultChunk> {
  private buffered = Buffer.alloc(0);

  constructor(private readonly limits: DaemonWireLimits) {}

  append(bytes: Uint8Array): readonly (unknown | DaemonResultChunk)[] {
    this.buffered = Buffer.concat([this.buffered, bytes]);
    const values: (unknown | DaemonResultChunk)[] = [];
    while (this.buffered.byteLength >= FRAME_PREFIX_BYTES) {
      const encodedLength = this.buffered.readUInt32BE(0);
      const binary = (encodedLength & BINARY_FRAME_FLAG) !== 0;
      const payloadLength = encodedLength & FRAME_LENGTH_MASK;
      const maximumPayloadBytes = binary
        ? this.limits.maximumExecutionControlPayloadBytes + this.limits.maximumChunkRawBytes
        : this.limits.maximumExecutionControlPayloadBytes;
      if (payloadLength > maximumPayloadBytes) {
        throw new Error("Daemon result frame exceeds capacity");
      }
      if (this.buffered.byteLength < payloadLength + FRAME_PREFIX_BYTES) break;
      const payload = this.buffered.subarray(
        FRAME_PREFIX_BYTES,
        payloadLength + FRAME_PREFIX_BYTES,
      );
      this.buffered = this.buffered.subarray(payloadLength + FRAME_PREFIX_BYTES);
      if (binary) {
        values.push(DaemonResultChunkCodec.decode(payload, this.limits));
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

class DaemonResultChunkCodec {
  static encode(chunk: DaemonResultChunk, limits: DaemonWireLimits): Uint8Array {
    DaemonResultChunkCodec.assertChunk(chunk, limits.maximumChunkRawBytes);
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
    if (
      BINARY_HEADER_LENGTH_BYTES + headerBytes.byteLength >
      limits.maximumExecutionControlPayloadBytes
    ) {
      throw new Error("Daemon result frame exceeds capacity");
    }
    const payloadLength =
      BINARY_HEADER_LENGTH_BYTES + headerBytes.byteLength + chunk.bytes.byteLength;
    const encoded = Buffer.alloc(FRAME_PREFIX_BYTES + payloadLength);
    encoded.writeUInt32BE((BINARY_FRAME_FLAG | payloadLength) >>> 0, 0);
    encoded.writeUInt32BE(headerBytes.byteLength, FRAME_PREFIX_BYTES);
    headerBytes.copy(encoded, FRAME_PREFIX_BYTES + BINARY_HEADER_LENGTH_BYTES);
    Buffer.from(chunk.bytes).copy(
      encoded,
      FRAME_PREFIX_BYTES + BINARY_HEADER_LENGTH_BYTES + headerBytes.byteLength,
    );
    return encoded;
  }

  static decode(payload: Buffer, limits: DaemonWireLimits): DaemonResultChunk {
    if (payload.byteLength < BINARY_HEADER_LENGTH_BYTES) {
      throw new Error("Truncated daemon result chunk header");
    }
    const headerLength = payload.readUInt32BE(0);
    if (headerLength === 0 || headerLength > payload.byteLength - BINARY_HEADER_LENGTH_BYTES) {
      throw new Error("Invalid daemon result chunk header length");
    }
    if (BINARY_HEADER_LENGTH_BYTES + headerLength > limits.maximumExecutionControlPayloadBytes) {
      throw new Error("Daemon result frame exceeds capacity");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        payload
          .subarray(BINARY_HEADER_LENGTH_BYTES, BINARY_HEADER_LENGTH_BYTES + headerLength)
          .toString("utf8"),
      );
    } catch {
      throw new Error("Malformed daemon result chunk header");
    }
    const bytes = payload.subarray(BINARY_HEADER_LENGTH_BYTES + headerLength);
    if (
      !DaemonResultChunkCodec.isHeader(parsed, limits.maximumChunkRawBytes) ||
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
    DaemonResultChunkCodec.assertChunk(chunk, limits.maximumChunkRawBytes);
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
    const expectedKeys = [
      "offset",
      "payloadLength",
      "requestId",
      "sequence",
      "sha256",
      "stream",
      "transferId",
    ];
    return (
      DaemonResultChunkCodec.hasExactKeys(header, expectedKeys) &&
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

  private static hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return (
      actual.length === expected.length && actual.every((key, index) => key === expected[index])
    );
  }
}
