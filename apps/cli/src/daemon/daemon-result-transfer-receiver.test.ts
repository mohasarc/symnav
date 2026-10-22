import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  DaemonExecutorExecutionResult,
  DaemonOutputRecord,
  DaemonSequencedOutputRecord,
} from "@symnav/daemon";
import type { CompletionSpoolManifest } from "./completion-spool.js";
import type { DaemonExecutionServerFrame, DaemonResultChunk } from "./daemon-protocol.js";
import type {
  DaemonCapturedOutput,
  DaemonCapturedOutputSummary,
  DaemonOutputCapture,
} from "./daemon-client-result-capture.js";
import { DaemonResultTransferReceiver } from "./daemon-result-transfer-receiver.js";

describe("DaemonResultTransferReceiver", () => {
  it("requires one matching manifest at the start of every connection", async () => {
    const output = new FakeCapture(summary([]));
    const receiver = new DaemonResultTransferReceiver("request", output);

    await expect(receiver.acceptChunk(chunk(0))).rejects.toThrow(
      "Daemon returned an invalid result chunk",
    );
    expect(() => receiver.acceptEnd(resultEnd(manifest()))).toThrow(
      "Daemon result transfer did not match its manifest",
    );
    expect(() =>
      receiver.acceptManifest(resultManifest(manifest(), { requestId: "other" })),
    ).toThrow("Daemon result manifest has invalid coordinates");
    receiver.acceptManifest(resultManifest(manifest()));
    expect(() => receiver.acceptManifest(resultManifest(manifest()))).toThrow(
      "Duplicate result manifest",
    );

    receiver.beginConnection();
    expect(receiver.manifest).toEqual(manifest());
    expect(receiver.nextOffset).toBe(0);
    expect(receiver.terminal).toBe(false);
    receiver.acceptManifest(resultManifest(manifest()));

    receiver.beginConnection();
    expect(() =>
      receiver.acceptManifest(resultManifest({ ...manifest(), transferId: "different" })),
    ).toThrow("Daemon resumed with a different result manifest");
  });

  it.each([
    { requestId: "other" },
    { instanceId: "other" },
    { exitCode: 1 },
    { rawBytes: 1 },
    { recordCount: 1 },
    { sha256: "f".repeat(64) },
  ] as const)("rejects a changed resumed manifest: %j", (change) => {
    const receiver = new DaemonResultTransferReceiver("request", new FakeCapture(summary([])));
    receiver.acceptManifest(resultManifest(manifest()));
    receiver.beginConnection();

    expect(() => receiver.acceptManifest(resultManifest({ ...manifest(), ...change }))).toThrow(
      "Daemon resumed with a different result manifest",
    );
  });

  it("advances its offset only after the matching record is durably appended", async () => {
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const output = new FakeCapture(summary([]), async () => appendGate);
    const receiver = new DaemonResultTransferReceiver("request", output);
    receiver.acceptManifest(resultManifest(manifest({ recordCount: 1, rawBytes: 1 })));

    const accepting = receiver.acceptChunk(chunk(0));
    expect(receiver.nextOffset).toBe(0);
    releaseAppend();
    await accepting;

    expect(receiver.nextOffset).toBe(1);
    expect(output.appended).toEqual([{ sequence: 0, stream: "stdout", bytes: Buffer.from("a") }]);
    receiver.beginConnection();
    expect(receiver.manifest).toEqual(manifest({ recordCount: 1, rawBytes: 1 }));
    expect(receiver.nextOffset).toBe(1);
    expect(receiver.terminal).toBe(false);
    receiver.acceptManifest(resultManifest(manifest({ recordCount: 1, rawBytes: 1 })));
  });

  it.each([
    { transferId: "other" },
    { requestId: "other" },
    { offset: 1 },
    { sequence: 1 },
  ] as const)("rejects invalid chunk coordinates: %j", async (change) => {
    const receiver = new DaemonResultTransferReceiver("request", new FakeCapture(summary([])));
    receiver.acceptManifest(resultManifest(manifest({ recordCount: 1, rawBytes: 1 })));

    await expect(receiver.acceptChunk({ ...chunk(0), ...change })).rejects.toThrow(
      "Daemon returned an invalid result chunk",
    );
  });

  it("requires one matching end after every manifest record", async () => {
    const records = [chunk(0), chunk(1, "stderr")];
    const expectedSummary = summary(records);
    const expectedManifest = manifest(expectedSummary);
    const receiver = new DaemonResultTransferReceiver("request", new FakeCapture(expectedSummary));
    receiver.acceptManifest(resultManifest(expectedManifest));
    expect(() => receiver.acceptEnd(resultEnd(expectedManifest))).toThrow(
      "Daemon result transfer did not match its manifest",
    );
    for (const record of records) await receiver.acceptChunk(record);
    receiver.acceptEnd(resultEnd(expectedManifest));

    expect(receiver.terminal).toBe(true);
    await expect(receiver.acceptChunk(chunk(2))).rejects.toThrow(
      "Daemon returned an invalid result chunk",
    );
    expect(() => receiver.acceptEnd(resultEnd(expectedManifest))).toThrow(
      "Daemon result transfer did not match its manifest",
    );
  });

  it.each([
    { instanceId: "other" },
    { transferId: "other" },
    { requestId: "other" },
    { rawBytes: 2 },
    { recordCount: 2 },
    { sha256: "f".repeat(64) },
  ] as const)("rejects invalid end coordinates: %j", (change) => {
    const receiver = new DaemonResultTransferReceiver("request", new FakeCapture(summary([])));
    receiver.acceptManifest(resultManifest(manifest()));

    expect(() => receiver.acceptEnd({ ...resultEnd(manifest()), ...change })).toThrow(
      "Daemon result transfer did not match its manifest",
    );
  });

  it("returns the captured result only after terminal summary validation", async () => {
    const expectedSummary = summary([]);
    const output = new FakeCapture(expectedSummary);
    const receiver = new DaemonResultTransferReceiver("request", output);

    await expect(receiver.finish()).rejects.toThrow("Daemon result transfer is incomplete");
    receiver.acceptManifest(resultManifest(manifest(expectedSummary)));
    receiver.acceptEnd(resultEnd(manifest(expectedSummary)));

    await expect(receiver.finish()).resolves.toBe(output.result);
    expect(output.finishExitCodes).toEqual([0]);
  });

  it("disposes a captured result that fails digest validation", async () => {
    const output = new FakeCapture({ ...summary([]), sha256: "f".repeat(64) });
    const receiver = new DaemonResultTransferReceiver("request", output);
    receiver.acceptManifest(resultManifest(manifest()));
    receiver.acceptEnd(resultEnd(manifest()));

    await expect(receiver.finish()).rejects.toThrow(
      "Daemon result transfer failed digest validation",
    );
    expect(output.resultOutput.dispose).toHaveBeenCalledOnce();
  });

  it("disposes abandoned partial capture once but leaves completed output caller-owned", async () => {
    const partial = new FakeCapture(summary([]));
    const partialReceiver = new DaemonResultTransferReceiver("request", partial);
    partialReceiver.acceptManifest(resultManifest(manifest()));
    await partialReceiver.dispose();
    await partialReceiver.dispose();
    expect(partial.disposeCalls).toBe(1);

    const completed = new FakeCapture(summary([]));
    const completedReceiver = new DaemonResultTransferReceiver("request", completed);
    completedReceiver.acceptManifest(resultManifest(manifest()));
    completedReceiver.acceptEnd(resultEnd(manifest()));
    await completedReceiver.finish();
    await completedReceiver.dispose();
    expect(completed.disposeCalls).toBe(0);
    expect(completed.resultOutput.dispose).not.toHaveBeenCalled();
  });
});

class FakeCapture implements DaemonOutputCapture {
  readonly appended: DaemonSequencedOutputRecord[] = [];
  readonly finishExitCodes: number[] = [];
  readonly resultOutput = new FakeOutput();
  readonly result: DaemonExecutorExecutionResult = { exitCode: 0, output: this.resultOutput };
  disposeCalls = 0;

  constructor(
    private readonly capturedSummary: DaemonCapturedOutputSummary,
    private readonly appendOperation: () => Promise<void> = () => Promise.resolve(),
  ) {}

  async append(record: DaemonSequencedOutputRecord): Promise<void> {
    await this.appendOperation();
    this.appended.push({ ...record, bytes: Buffer.from(record.bytes) });
  }

  finish(exitCode: number): Promise<DaemonCapturedOutput> {
    this.finishExitCodes.push(exitCode);
    return Promise.resolve({
      result: this.result,
      summary: this.capturedSummary,
    });
  }

  dispose(): Promise<void> {
    this.disposeCalls += 1;
    return Promise.resolve();
  }
}

class FakeOutput {
  readonly dispose = vi.fn(() => Promise.resolve());

  async *records(): AsyncIterable<DaemonOutputRecord> {}
}

function manifest(overrides: Partial<CompletionSpoolManifest> = {}): CompletionSpoolManifest {
  return {
    transferId: "transfer",
    requestId: "request",
    instanceId: "instance",
    exitCode: 0,
    rawBytes: 0,
    recordCount: 0,
    sha256: createHash("sha256").digest("hex"),
    ...overrides,
  };
}

function resultManifest(
  value: CompletionSpoolManifest,
  overrides: Partial<ResultManifestFrame> = {},
): ResultManifestFrame {
  return {
    kind: "result-manifest",
    instanceId: value.instanceId,
    processToken: "token",
    requestId: value.requestId,
    manifest: value,
    ...overrides,
  };
}

function resultEnd(
  value: CompletionSpoolManifest,
): Extract<DaemonExecutionServerFrame, { readonly kind: "result-end" }> {
  return {
    kind: "result-end",
    instanceId: value.instanceId,
    processToken: "token",
    requestId: value.requestId,
    transferId: value.transferId,
    rawBytes: value.rawBytes,
    recordCount: value.recordCount,
    sha256: value.sha256,
  };
}

type ResultManifestFrame = Extract<
  DaemonExecutionServerFrame,
  { readonly kind: "result-manifest" }
>;

function chunk(sequence: number, stream: "stdout" | "stderr" = "stdout"): DaemonResultChunk {
  return {
    transferId: "transfer",
    requestId: "request",
    offset: sequence,
    sequence,
    stream,
    bytes: Buffer.from(String.fromCharCode(97 + sequence)),
  };
}

function summary(records: readonly DaemonResultChunk[]): DaemonCapturedOutputSummary {
  const hash = createHash("sha256");
  let rawBytes = 0;
  for (const record of records) {
    const encoded = Buffer.alloc(5 + record.bytes.byteLength);
    encoded.writeUInt8(record.stream === "stdout" ? 0 : 1, 0);
    encoded.writeUInt32BE(record.bytes.byteLength, 1);
    Buffer.from(record.bytes).copy(encoded, 5);
    hash.update(encoded);
    rawBytes += record.bytes.byteLength;
  }
  return { rawBytes, recordCount: records.length, sha256: hash.digest("hex") };
}
