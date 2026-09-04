import { createHash } from "node:crypto";
import {
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DaemonSequencedOutputRecord } from "@symnav/daemon";
import { DaemonClientResultCapture } from "./daemon-client-result-capture.js";

describe("DaemonClientResultCapture", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
    directories.length = 0;
  });

  it("spills on the first byte beyond the inline threshold without changing framing", async () => {
    const root = temporaryDirectory(directories);
    const directory = join(root, "capture");
    const capture = new DaemonClientResultCapture({
      directory,
      policy: policy({ inlineRawBytes: 4 }),
    });
    const records: DaemonSequencedOutputRecord[] = [
      { sequence: 0, stream: "stdout", bytes: Buffer.from([0, 255, 10, 13]) },
      { sequence: 1, stream: "stderr", bytes: Buffer.from([128]) },
    ];

    await capture.append(records[0]!);
    expect(() => statSync(directory)).toThrow();
    await capture.append(records[1]!);
    const [file] = readdirSync(directory);
    expect(file).toMatch(/^command-output-.+\.spool$/);
    if (process.platform !== "win32") {
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(join(directory, file!)).mode & 0o777).toBe(0o600);
    }
    const captured = await capture.finish(7);

    expect(captured.summary).toEqual({
      rawBytes: 5,
      recordCount: 2,
      sha256: digest(records),
    });
    expect(captured.result.exitCode).toBe(7);
    expect(captured.result.output).not.toHaveProperty("summary");
    expect(await replay(captured.result.output.records())).toEqual([
      { stream: "stdout", bytes: "00ff0a0d" },
      { stream: "stderr", bytes: "80" },
    ]);
    await captured.result.output.dispose();
    expect(readdirSync(directory)).toEqual([]);
    await captured.result.output.dispose();
  });

  it("replays more than eight MiB of interleaved binary output byte for byte", async () => {
    const directory = temporaryDirectory(directories);
    const maximumChunkRawBytes = 64 * 1024;
    const recordCount = 129;
    const capture = new DaemonClientResultCapture({
      directory,
      policy: {
        maximumChunkRawBytes,
        inlineRawBytes: 0,
        maximumResultRawBytes: recordCount * maximumChunkRawBytes,
      },
    });
    const expected: Array<{ stream: "stdout" | "stderr"; bytes: string }> = [];
    for (let sequence = 0; sequence < recordCount; sequence += 1) {
      const record: DaemonSequencedOutputRecord = {
        sequence,
        stream: sequence % 2 === 0 ? "stdout" : "stderr",
        bytes: Buffer.alloc(maximumChunkRawBytes, sequence),
      };
      expected.push({ stream: record.stream, bytes: Buffer.from(record.bytes).toString("hex") });
      await capture.append(record);
    }

    const captured = await capture.finish(0);

    expect(captured.summary.rawBytes).toBe(recordCount * maximumChunkRawBytes);
    expect(await replay(captured.result.output.records())).toEqual(expected);
    await captured.result.output.dispose();
  }, 20_000);

  it("accepts the result limit and rejects the first byte beyond it", async () => {
    const directory = temporaryDirectory(directories);
    const capture = new DaemonClientResultCapture({
      directory,
      policy: {
        maximumChunkRawBytes: 4,
        inlineRawBytes: 0,
        maximumResultRawBytes: 5,
      },
    });

    await capture.append({ sequence: 0, stream: "stdout", bytes: Buffer.alloc(4) });
    await capture.append({ sequence: 1, stream: "stderr", bytes: Buffer.alloc(1) });
    await expect(
      capture.append({ sequence: 2, stream: "stdout", bytes: Buffer.alloc(1) }),
    ).rejects.toMatchObject({
      name: "CommandOutputCapacityError",
      message: "Command output exceeds response capacity",
    });
    await expect(capture.finish(0)).rejects.toMatchObject({
      name: "CommandOutputCapacityError",
    });
    await capture.dispose();
    expect(readdirSync(directory)).toEqual([]);
  });

  it("rejects a record beyond the chunk bound before storing it", async () => {
    const directory = temporaryDirectory(directories);
    const capture = new DaemonClientResultCapture({
      directory,
      policy: {
        maximumChunkRawBytes: 3,
        inlineRawBytes: 0,
        maximumResultRawBytes: 10,
      },
    });

    await expect(
      capture.append({ sequence: 0, stream: "stdout", bytes: Buffer.alloc(4) }),
    ).rejects.toThrow("Command output record exceeds chunk capacity");
    await capture.dispose();
    expect(readdirSync(directory)).toEqual([]);
  });

  it.each([
    ["truncated header", (encoded: Buffer) => encoded.subarray(0, 8), "Truncated command output"],
    [
      "wrong sequence",
      (encoded: Buffer) => {
        encoded.writeUInt32BE(1, 0);
        return encoded;
      },
      "Corrupt command output",
    ],
    [
      "invalid stream",
      (encoded: Buffer) => {
        encoded.writeUInt8(2, 4);
        return encoded;
      },
      "Corrupt command output",
    ],
    [
      "oversized record",
      (encoded: Buffer) => {
        encoded.writeUInt32BE(4, 5);
        return Buffer.concat([encoded.subarray(0, 9), Buffer.alloc(4)]);
      },
      "Corrupt command output",
    ],
  ] as const)("rejects a %s in stored output", async (_name, corrupt, message) => {
    const { directory, path, output } = await storedOutput(directories);
    writeFileSync(path, corrupt(readFileSync(path)));

    await expect(replay(output.records())).rejects.toThrow(message);
    await output.dispose();
    expect(readdirSync(directory)).toEqual([]);
  });

  it("requires a regular result file", async () => {
    const { path, output } = await storedOutput(directories);
    rmSync(path);
    mkdirSync(path);

    await expect(replay(output.records())).rejects.toThrow(
      "Command output spool is not a regular file",
    );
  });

  it.runIf("O_NOFOLLOW" in constants && constants.O_NOFOLLOW !== 0)(
    "does not follow a replacement result-file link",
    async () => {
      const { path, output } = await storedOutput(directories);
      const target = `${path}.target`;
      renameSync(path, target);
      symlinkSync(target, path);

      await expect(replay(output.records())).rejects.toBeDefined();
      await output.dispose();
    },
  );
});

function policy(overrides: Partial<CapturePolicy> = {}): CapturePolicy {
  return {
    maximumChunkRawBytes: 64 * 1024,
    inlineRawBytes: 256 * 1024,
    maximumResultRawBytes: 256 * 1024 * 1024,
    ...overrides,
  };
}

interface CapturePolicy {
  readonly maximumChunkRawBytes: number;
  readonly inlineRawBytes: number;
  readonly maximumResultRawBytes: number;
}

function temporaryDirectory(directories: string[]): string {
  const directory = mkdtempSync(join(tmpdir(), "symnav-client-capture-"));
  directories.push(directory);
  return directory;
}

function digest(records: readonly DaemonSequencedOutputRecord[]): string {
  const hash = createHash("sha256");
  for (const record of records) hash.update(encode(record).subarray(4));
  return hash.digest("hex");
}

function encode(record: DaemonSequencedOutputRecord): Buffer {
  const header = Buffer.alloc(9);
  header.writeUInt32BE(record.sequence, 0);
  header.writeUInt8(record.stream === "stdout" ? 0 : 1, 4);
  header.writeUInt32BE(record.bytes.byteLength, 5);
  return Buffer.concat([header, Buffer.from(record.bytes)]);
}

async function replay(
  records: AsyncIterable<{ readonly stream: "stdout" | "stderr"; readonly bytes: Uint8Array }>,
): Promise<Array<{ stream: "stdout" | "stderr"; bytes: string }>> {
  const replayed = [];
  for await (const record of records) {
    replayed.push({ stream: record.stream, bytes: Buffer.from(record.bytes).toString("hex") });
  }
  return replayed;
}

async function storedOutput(directories: string[]) {
  const directory = temporaryDirectory(directories);
  const capture = new DaemonClientResultCapture({
    directory,
    policy: {
      maximumChunkRawBytes: 3,
      inlineRawBytes: 0,
      maximumResultRawBytes: 10,
    },
  });
  await capture.append({ sequence: 0, stream: "stdout", bytes: Buffer.from([1]) });
  const captured = await capture.finish(0);
  return {
    directory,
    path: join(directory, readdirSync(directory)[0]!),
    output: captured.result.output,
  };
}
