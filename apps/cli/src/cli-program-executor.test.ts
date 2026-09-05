import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryFileSystem, type OverviewFileEntries, WorkspaceSession } from "@symnav/core";
import { DaemonPolicyTestFactory } from "../test/helpers/daemon-policy.js";
import * as commandExecutionResult from "./command-execution-result.js";
import { CliProgramExecutor, CommandResultReplayer } from "./cli-program-executor.js";
import { fakeDependencies } from "../test/integration/commands/helpers/fake-program-dependencies.js";
import { createCapturingRecorder } from "../test/integration/commands/helpers/fake-program-dependencies.js";
import { createFakeProgramContext } from "../test/integration/commands/helpers/fake-program-context.js";
import { FakeLanguageBackend } from "../test/integration/commands/helpers/fake-language-backend.js";

describe("CliProgramExecutor", () => {
  const temporaryRoots: string[] = [];

  afterEach(() => {
    delete process.env.SYMNAV_STATE_DIR;
    for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
    temporaryRoots.length = 0;
  });

  it("captures successful command frames in write order and replays exact bytes", async () => {
    const entries: OverviewFileEntries = {
      file: "src/a.ts",
      entries: [],
      diagnostics: [{ severity: "warning", dedupeKey: "warning", message: "unicode ✓\nnext" }],
    };
    const executor = new CliProgramExecutor(
      fakeDependencies({ backends: () => [new FakeLanguageBackend({ entries: () => entries })] }),
    );

    const result = await executor.execute({
      argv: ["overview", "src/a.ts"],
      cwd: "/repo",
      telemetryEnabled: false,
    });

    expect(result.exitCode).toBe(0);
    expect((await records(result)).map((record) => record.stream)).toEqual(["stderr", "stdout"]);
    const context = createFakeProgramContext({ cwd: "/repo" });
    await CommandResultReplayer.replay(result, context);
    expect(context.stderr.text()).toBe("Warning: unicode ✓\nnext\n");
    expect(context.stdout.text()).toBe("Overview: src/a.ts\n(no symbols)\n");
    expect(context.exitCodes).toEqual([]);
  });

  it("replays identical ordered bytes from inline and spilled command output", async () => {
    const spillDirectory = mkdtempSync(join(tmpdir(), "symnav-ordered-output-"));
    temporaryRoots.push(spillDirectory);
    const OrderedCommandOutput = (
      commandExecutionResult as unknown as {
        OrderedCommandOutput: new (options: {
          readonly policy: ReturnType<typeof fakeDependencies>["daemonPolicy"]["values"]["output"];
          readonly directory?: string;
        }) => {
          readonly stdout: Writable;
          readonly stderr: Writable;
          finish(exitCode: number): Promise<{
            readonly exitCode: number;
            readonly output: {
              readonly summary: { readonly rawBytes: number; readonly recordCount: number };
              records(): AsyncIterable<{
                readonly sequence: number;
                readonly stream: "stdout" | "stderr";
                readonly bytes: Uint8Array;
              }>;
              dispose(): Promise<void>;
            };
          }>;
        };
      }
    ).OrderedCommandOutput;
    const writes = Array.from({ length: 128 }, (_, index) => ({
      stream: index % 3 === 0 ? ("stderr" as const) : ("stdout" as const),
      bytes: Buffer.from(`${index}:unicode-✓\n`),
    }));
    const expectedStreams = writes.reduce<Array<"stdout" | "stderr">>((streams, write) => {
      if (streams.at(-1) !== write.stream) streams.push(write.stream);
      return streams;
    }, []);
    const basePolicy = fakeDependencies().daemonPolicy;
    const capture = async (inlineBytes: number) => {
      const policy = DaemonPolicyTestFactory.withOverrides(basePolicy, {
        output: {
          maximumChunkRawBytes: Math.min(
            basePolicy.values.output.maximumChunkRawBytes,
            inlineBytes,
          ),
          inlineRawBytes: inlineBytes,
          maximumResultRawBytes: Math.max(
            basePolicy.values.output.maximumResultRawBytes,
            inlineBytes,
          ),
          maximumAggregateSpoolRawBytes: Math.max(
            basePolicy.values.output.maximumAggregateSpoolRawBytes,
            inlineBytes,
          ),
        },
      });
      const output = new OrderedCommandOutput({
        directory: spillDirectory,
        policy: policy.values.output,
      });
      for (const write of writes) {
        await new Promise<void>((resolve, reject) => {
          output[write.stream].write(write.bytes, (error) => (error ? reject(error) : resolve()));
        });
      }
      const result = await output.finish(7);
      const records = [];
      for await (const record of result.output.records()) {
        records.push({ ...record, bytes: Buffer.from(record.bytes).toString("hex") });
      }
      await result.output.dispose();
      return { result, records };
    };

    const inline = await capture(Number.MAX_SAFE_INTEGER);
    const spilled = await capture(32);

    expect(spilled.records).toEqual(inline.records);
    expect(inline.result.exitCode).toBe(7);
    expect(inline.result.output.summary.rawBytes).toBe(
      writes.reduce((total, write) => total + write.bytes.byteLength, 0),
    );
    expect(inline.result.output.summary.recordCount).toBe(expectedStreams.length);
    expect(inline.records.map(({ sequence, stream }) => ({ sequence, stream }))).toEqual(
      expectedStreams.map((stream, sequence) => ({ sequence, stream })),
    );
  });

  it("advances nonempty output at the smallest valid chunk capacity", async () => {
    const dependencies = fakeDependencies();
    const policy = DaemonPolicyTestFactory.withOverrides(dependencies.daemonPolicy, {
      output: { maximumChunkRawBytes: 1 },
    });
    const output = new commandExecutionResult.OrderedCommandOutput({
      policy: policy.values.output,
    });

    await new Promise<void>((resolve, reject) => {
      output.stdout.write(Buffer.from("ab"), (error) => (error ? reject(error) : resolve()));
    });
    const result = await output.finish(0);

    expect(await decode(result)).toBe("ab");
    expect(result.output.summary.rawBytes).toBe(2);
    await result.output.dispose();
  });

  it("serializes replay through terminal backpressure and disposes after completion", async () => {
    const output = new commandExecutionResult.CommandOutputSnapshot([
      { stream: "stdout", bytes: Buffer.from("one") },
      { stream: "stderr", bytes: Buffer.from("two") },
      { stream: "stdout", bytes: Buffer.from("three") },
    ]);
    const dispose = vi.spyOn(output, "dispose");
    const writes: string[] = [];
    const stdout = new GatedWritable(writes, "stdout");
    const stderr = new GatedWritable(writes, "stderr");
    const replay = CommandResultReplayer.replay(
      { output, exitCode: 0 },
      { cwd: "/repo", stdout, stderr, exit: () => undefined as never },
    );

    await vi.waitFor(() => expect(stdout.pendingCount).toBe(1));
    expect(stderr.pendingCount).toBe(0);
    expect(writes).toEqual(["stdout:one"]);
    stdout.release();
    await vi.waitFor(() => expect(stderr.pendingCount).toBe(1));
    expect(writes).toEqual(["stdout:one", "stderr:two"]);
    stderr.release();
    await vi.waitFor(() => expect(stdout.pendingCount).toBe(1));
    expect(writes).toEqual(["stdout:one", "stderr:two", "stdout:three"]);
    stdout.release();

    await replay;
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("disposes retained output when terminal replay fails", async () => {
    const output = new commandExecutionResult.CommandOutputSnapshot([
      { stream: "stdout", bytes: Buffer.from("one") },
      { stream: "stderr", bytes: Buffer.from("two") },
    ]);
    const dispose = vi.spyOn(output, "dispose");
    const stdout = new GatedWritable([], "stdout");
    const stderr = new GatedWritable([], "stderr");
    const replay = CommandResultReplayer.replay(
      { output, exitCode: 0 },
      { cwd: "/repo", stdout, stderr, exit: () => undefined as never },
    );

    await vi.waitFor(() => expect(stdout.pendingCount).toBe(1));
    stdout.fail(new Error("terminal disappeared"));

    await expect(replay).rejects.toThrow("terminal disappeared");
    expect(stderr.pendingCount).toBe(0);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it.each([
    { argv: ["--version"], code: 0, stream: "stdout" },
    { argv: ["--help"], code: 0, stream: "stdout" },
    { argv: ["overview", "--help"], code: 0, stream: "stdout" },
    { argv: [], code: 1, stream: "stderr" },
    { argv: ["def"], code: 1, stream: "stderr" },
    { argv: ["wat"], code: 1, stream: "stderr" },
  ] as const)("captures Commander execution for $argv", async ({ argv, code, stream }) => {
    const result = await new CliProgramExecutor(fakeDependencies()).execute({
      argv,
      cwd: "/repo",
      telemetryEnabled: false,
    });

    expect(result.exitCode).toBe(code);
    const captured = await records(result);
    expect(captured.length).toBeGreaterThan(0);
    expect(captured.every((record) => record.stream === stream)).toBe(true);
    await result.output.dispose();
  });

  it.each([["--version"], ["--help"], ["overview", "--help"]])(
    "does not construct backends for help invocation %j",
    async (...argv) => {
      const backends = vi.fn(() => {
        throw new Error("help must not construct backends");
      });

      const result = await new CliProgramExecutor(fakeDependencies({ backends })).execute({
        argv,
        cwd: "/repo",
        telemetryEnabled: false,
      });

      expect(result.exitCode).toBe(0);
      expect(backends).not.toHaveBeenCalled();
      await result.output.dispose();
    },
  );

  it("captures user errors, crashes, JSON, and hidden stats", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "symnav-executor-"));
    temporaryRoots.push(stateDir);
    process.env.SYMNAV_STATE_DIR = stateDir;
    const userError = await new CliProgramExecutor(fakeDependencies()).execute({
      argv: ["overview", "missing.ts"],
      cwd: "/repo",
      telemetryEnabled: false,
    });
    const crash = await new CliProgramExecutor(
      fakeDependencies({
        backends: () => [
          new FakeLanguageBackend({
            entries: () => {
              throw new Error("boom");
            },
          }),
        ],
      }),
    ).execute({ argv: ["overview", "src/a.ts"], cwd: "/repo", telemetryEnabled: false });
    const json = await new CliProgramExecutor(fakeDependencies()).execute({
      argv: ["overview", "src/a.ts", "--json"],
      cwd: "/repo",
      telemetryEnabled: false,
    });
    const stats = await new CliProgramExecutor(fakeDependencies()).execute({
      argv: ["stats", "--json"],
      cwd: "/repo",
      telemetryEnabled: false,
    });

    expect(userError.exitCode).toBe(1);
    expect(await decode(userError)).toContain("Cannot answer: file not found");
    expect(crash.exitCode).toBe(2);
    expect(await decode(crash)).toBe("boom\n");
    expect(JSON.parse(await decode(json))).toMatchObject({ file: "src/a.ts" });
    expect(JSON.parse(await decode(stats))).toMatchObject({ totalEvents: 0 });
  });

  it("records one warm telemetry event at the executing process", async () => {
    const recorder = createCapturingRecorder();
    const result = await new CliProgramExecutor(
      fakeDependencies({ recorder, telemetryEnabled: true }),
    ).execute({
      argv: ["overview", "src/a.ts"],
      cwd: "/repo",
      telemetryEnabled: true,
      executionMode: "warm",
    });

    expect(recorder.events).toEqual([
      expect.objectContaining({
        command: "overview",
        executionMode: "warm",
        outcome: "success",
      }),
    ]);
    expect(result).not.toHaveProperty("telemetry");
  });

  it("replaces local output over the result limit without partial bytes", async () => {
    const dependencies = fakeDependencies();
    const daemonPolicy = DaemonPolicyTestFactory.withOverrides(dependencies.daemonPolicy, {
      output: {
        maximumChunkRawBytes: 1,
        inlineRawBytes: 1,
        maximumResultRawBytes: 1,
      },
    });
    const result = await new CliProgramExecutor({ ...dependencies, daemonPolicy }).execute({
      argv: ["--version"],
      cwd: "/repo",
      telemetryEnabled: false,
    });

    expect(result.exitCode).toBe(1);
    expect(await decode(result)).toBe("Cannot answer: daemon response capacity exceeded.\n");
  });

  it("creates a fresh request session for each non-injected navigation", async () => {
    const fs = new ListingCountingFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/src/a.ts": "export const a = 1;\n",
    });
    const createdBackends: FakeLanguageBackend[] = [];
    const backends = vi.fn(() => {
      const backend = new FakeLanguageBackend({ accept: (path) => path.endsWith(".ts") });
      createdBackends.push(backend);
      return [backend];
    });
    const executor = new CliProgramExecutor(fakeDependencies({ fs, backends }));

    await executor.execute({ argv: ["resolve", "a"], cwd: "/repo", telemetryEnabled: false });
    fs.directoryReads.length = 0;
    await executor.execute({ argv: ["resolve", "a"], cwd: "/repo", telemetryEnabled: false });

    expect(backends).toHaveBeenCalledTimes(2);
    expect(createdBackends).toHaveLength(2);
    expect(fs.directoryReads).not.toEqual([]);
  });

  it("reuses an injected workspace session across executions", async () => {
    const fs = new ListingCountingFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/src/a.ts": "export const a = 1;\n",
    });
    const backend = new FakeLanguageBackend({ accept: (path) => path.endsWith(".ts") });
    const workspaceSession = new WorkspaceSession({
      fileSystem: fs,
      backends: [backend],
      discoveryRetention: "session",
    });
    const executor = new CliProgramExecutor(
      fakeDependencies({ fs, backends: () => [backend] }),
      workspaceSession,
    );

    await executor.execute({
      argv: ["resolve", "a"],
      cwd: "/repo",
      telemetryEnabled: false,
    });
    fs.directoryReads.length = 0;
    await executor.execute({
      argv: ["resolve", "a"],
      cwd: "/repo",
      telemetryEnabled: false,
    });

    expect(fs.directoryReads).toEqual([]);
  });
});

class GatedWritable extends Writable {
  private readonly callbacks: Array<(error?: Error | null) => void> = [];

  constructor(
    private readonly writes: string[],
    private readonly name: string,
  ) {
    super({ highWaterMark: 1 });
  }

  get pendingCount(): number {
    return this.callbacks.length;
  }

  release(): void {
    this.callbacks.shift()?.();
  }

  fail(error: Error): void {
    this.destroy(error);
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.writes.push(`${this.name}:${chunk.toString()}`);
    this.callbacks.push(callback);
  }
}

class ListingCountingFileSystem extends InMemoryFileSystem {
  readonly directoryReads: string[] = [];

  override async listDir(absPath: string): Promise<readonly string[]> {
    this.directoryReads.push(absPath);
    return super.listDir(absPath);
  }

  override listDirSync(absPath: string): readonly string[] {
    this.directoryReads.push(absPath);
    return super.listDirSync(absPath);
  }

  override metadataSync(absPath: string) {
    if (!this.isDirectorySync(absPath)) return super.metadataSync(absPath);
    const entries = super.listDirSync(absPath);
    return {
      size: entries.length,
      modifiedAtMs: 0,
      changeToken: entries.join("\0"),
      fileIdentity: absPath,
    };
  }
}

async function records(result: commandExecutionResult.CommandExecutionResult) {
  const captured = [];
  for await (const record of result.output.records()) captured.push(record);
  return captured;
}

async function decode(result: commandExecutionResult.CommandExecutionResult): Promise<string> {
  return Buffer.concat(
    (await records(result)).map((record) => Buffer.from(record.bytes)),
  ).toString();
}
