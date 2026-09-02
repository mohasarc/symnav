import { describe, expect, it } from "vitest";
import type { DaemonResultChunk } from "./daemon-protocol.js";
import { DaemonResultChunkCodec, DaemonTransferFrameDecoder } from "./daemon-result-chunk-codec.js";

describe("DaemonResultChunkCodec", () => {
  const chunk: DaemonResultChunk = {
    transferId: "transfer-1",
    requestId: "request-1",
    offset: 3,
    sequence: 3,
    stream: "stderr",
    bytes: Uint8Array.from([0, 255, 1, 2]),
  };

  it("round trips fragmented raw chunks alongside bounded control frames", () => {
    const controlPayload = Buffer.from(JSON.stringify({ kind: "result-end" }));
    const control = Buffer.alloc(4 + controlPayload.byteLength);
    control.writeUInt32BE(controlPayload.byteLength);
    controlPayload.copy(control, 4);
    const encoded = Buffer.concat([control, DaemonResultChunkCodec.encode(chunk)]);
    const decoder = new DaemonTransferFrameDecoder(256 * 1024);
    const decoded = [];
    for (let offset = 0; offset < encoded.byteLength; offset += 7) {
      decoded.push(...decoder.append(encoded.subarray(offset, offset + 7)));
    }
    decoder.assertComplete();

    expect(decoded).toEqual([{ kind: "result-end" }, chunk]);
    expect(encoded.includes(Buffer.from(chunk.bytes))).toBe(true);
  });

  it.each([
    (encoded: Buffer) => encoded.subarray(0, encoded.byteLength - 1),
    (encoded: Buffer) => {
      const corrupt = Buffer.from(encoded);
      corrupt.writeUInt32BE(1, 5);
      return corrupt;
    },
    (encoded: Buffer) => {
      const corrupt = Buffer.from(encoded);
      corrupt[corrupt.byteLength - 1] = corrupt[corrupt.byteLength - 1]! ^ 1;
      return corrupt;
    },
  ])("rejects truncated, wrong-length, or corrupt binary transfer %#", (corrupt) => {
    const decoder = new DaemonTransferFrameDecoder(256 * 1024);
    const encoded = corrupt(DaemonResultChunkCodec.encode(chunk));
    expect(() => {
      decoder.append(encoded);
      decoder.assertComplete();
    }).toThrow(/daemon result|truncated/i);
  });
});
