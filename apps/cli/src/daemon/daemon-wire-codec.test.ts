import { describe, expect, it } from "vitest";
import type { DaemonResultChunk } from "./daemon-protocol.js";
import { DaemonWireCodec, type DaemonWireLimits } from "./daemon-wire-codec.js";

const limits: DaemonWireLimits = {
  maximumJsonPayloadBytes: 512,
  maximumExecutionControlPayloadBytes: 256,
  maximumChunkRawBytes: 8,
};

describe("DaemonWireCodec", () => {
  it("decodes fragmented and coalesced Unicode control frames", () => {
    const codec = new DaemonWireCodec(limits);
    const decoder = codec.controlDecoder();
    const first = codec.encodeControl({ text: "one\n✓" });
    const second = codec.encodeControl({ text: "two\r\n終" });
    const encoded = Buffer.concat([first, second]);
    const decoded: unknown[] = [];

    for (let offset = 0; offset < encoded.byteLength; offset += 3) {
      decoded.push(...decoder.append(encoded.subarray(offset, offset + 3)));
    }
    decoder.assertComplete();

    expect(decoded).toEqual([{ text: "one\n✓" }, { text: "two\r\n終" }]);
  });

  it.each([
    ["header", Uint8Array.from([0, 0])],
    ["payload", Uint8Array.from([0, 0, 0, 4, 123, 125])],
  ] as const)("rejects a truncated %s with the current control error", (_part, encoded) => {
    const decoder = new DaemonWireCodec(limits).controlDecoder();
    decoder.append(encoded);

    expect(() => decoder.assertComplete()).toThrow(
      "Daemon connection ended with a truncated frame",
    );
  });

  it("rejects malformed and oversized ordinary JSON with current errors", () => {
    const codec = new DaemonWireCodec({ ...limits, maximumJsonPayloadBytes: 4 });
    const malformed = Uint8Array.from([0, 0, 0, 1, 123]);
    expect(() => codec.controlDecoder().append(malformed)).toThrow(
      "Daemon frame contains malformed JSON",
    );

    const oversized = Uint8Array.from([0, 0, 0, 5]);
    expect(() => codec.controlDecoder().append(oversized)).toThrow("Daemon frame exceeds 4 bytes");
    expect(() => codec.encodeControl({ value: "oversized" })).toThrow(
      "Daemon frame exceeds 4 bytes",
    );
  });

  it("preserves the binary flag, frame length, and four-byte header length", () => {
    const codec = new DaemonWireCodec(limits);
    const chunk = resultChunk(Uint8Array.from([0, 255, 1, 2]));
    const encoded = codec.encodeServerMessage(chunk);
    const encodedLength = Buffer.from(encoded).readUInt32BE(0);
    const payloadLength = encodedLength & 0x7fffffff;

    expect((encodedLength & 0x80000000) >>> 0).toBe(0x80000000);
    expect(payloadLength).toBe(encoded.byteLength - 4);
    expect(Buffer.from(encoded).readUInt32BE(4)).toBeGreaterThan(0);
    expect(codec.transferDecoder().append(encoded)).toEqual([chunk]);
  });

  it("keeps ordinary JSON, execution control, and raw chunk caps independent", () => {
    const codec = new DaemonWireCodec({
      maximumJsonPayloadBytes: 64,
      maximumExecutionControlPayloadBytes: 24,
      maximumChunkRawBytes: 2,
    });
    const ordinary = codec.encodeControl({ value: "fits ordinary cap" });
    expect(codec.controlDecoder().append(ordinary)).toEqual([{ value: "fits ordinary cap" }]);
    expect(() => codec.transferDecoder().append(ordinary)).toThrow(
      "Daemon result frame exceeds capacity",
    );
    expect(() =>
      codec.encodeServerMessage({ ...resultChunk(), bytes: Uint8Array.from([1, 2, 3]) }),
    ).toThrow("Invalid daemon result chunk");
  });

  it("encodes lifecycle responses against the ordinary JSON cap", () => {
    const codec = new DaemonWireCodec({
      maximumJsonPayloadBytes: 128,
      maximumExecutionControlPayloadBytes: 32,
      maximumChunkRawBytes: 8,
    });
    const response = {
      kind: "pong",
      protocolVersion: 5,
      instanceId: "instance",
      symnavVersion: "version-that-exceeds-the-control-cap",
    } as const;

    const encoded = codec.encodeServerMessage(response);

    expect(codec.controlDecoder().append(encoded)).toEqual([response]);
  });

  it("bounds a binary header by the execution-control envelope", () => {
    const encoded = new DaemonWireCodec({
      maximumJsonPayloadBytes: 256,
      maximumExecutionControlPayloadBytes: 256,
      maximumChunkRawBytes: 256,
    }).encodeServerMessage(resultChunk());
    const decoder = new DaemonWireCodec({
      maximumJsonPayloadBytes: 256,
      maximumExecutionControlPayloadBytes: 8,
      maximumChunkRawBytes: 256,
    }).transferDecoder();

    expect(() => decoder.append(encoded)).toThrow("Daemon result frame exceeds capacity");
  });
});

function resultChunk(bytes = Uint8Array.from([1])): DaemonResultChunk {
  return {
    transferId: "transfer-1",
    requestId: "request-1",
    offset: 3,
    sequence: 3,
    stream: "stderr",
    bytes,
  };
}
