import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryFileSystem, WorkspaceCatalog, type OverviewFileEntries } from "@symnav/core";
import { CliProgramExecutor, CommandResultReplayer } from "./cli-program-executor.js";
import { fakeDependencies } from "../test/integration/commands/helpers/fake-program-dependencies.js";
import { createCapturingRecorder } from "../test/integration/commands/helpers/fake-program-dependencies.js";
import { createFakeProgramContext } from "../test/integration/commands/helpers/fake-program-context.js";
import { FakeLanguageBackend } from "../test/integration/commands/helpers/fake-language-backend.js";
import { WorkspaceRequestScopeFactory } from "./workspace-request-scope.js";

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
    expect(result.frames.map((frame) => frame.stream)).toEqual(["stderr", "stdout"]);
    const context = createFakeProgramContext({ cwd: "/repo" });
    CommandResultReplayer.replay(result, context);
    expect(context.stderr.text()).toBe("Warning: unicode ✓\nnext\n");
    expect(context.stdout.text()).toBe("Overview: src/a.ts\n(no symbols)\n");
    expect(context.exitCodes).toEqual([]);
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
    expect(result.frames.length).toBeGreaterThan(0);
    expect(result.frames.every((frame) => frame.stream === stream)).toBe(true);
  });

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
    expect(decode(userError)).toContain("Cannot answer: file not found");
    expect(crash.exitCode).toBe(2);
    expect(decode(crash)).toBe("boom\n");
    expect(JSON.parse(decode(json))).toMatchObject({ file: "src/a.ts" });
    expect(JSON.parse(decode(stats))).toMatchObject({ totalEvents: 0 });
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

  it("reuses an injected request scope factory across executions", async () => {
    const fs = new ListingCountingFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/src/a.ts": "export const a = 1;\n",
    });
    const backend = new FakeLanguageBackend({ accept: (path) => path.endsWith(".ts") });
    const factory = new WorkspaceRequestScopeFactory(fs, [backend], new WorkspaceCatalog(fs));
    const executor = new CliProgramExecutor(
      fakeDependencies({ fs, backends: () => [backend] }),
      factory,
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

function decode(result: { readonly frames: readonly { readonly bytesBase64: string }[] }): string {
  return result.frames.map((frame) => Buffer.from(frame.bytesBase64, "base64").toString()).join("");
}
