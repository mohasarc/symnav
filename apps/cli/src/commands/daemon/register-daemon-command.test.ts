import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Command as CommanderCommand } from "commander";
import { DaemonPolicy } from "@symnav/daemon";
import { DaemonLifecycleRenderer } from "@symnav/renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonController } from "../../daemon/daemon-controller.js";
import { createDefaultDependencies } from "../../program.js";
import type { ProgramContext } from "../../program-context.js";
import type { ProgramDependencies } from "../../program-dependencies.js";
import { registerDaemonCommand } from "./register-daemon-command.js";

class CommandExit extends Error {
  constructor(readonly exitCode: number) {
    super();
  }
}

class DaemonCommandHarness {
  readonly stateDirectory = mkdtempSync(join(tmpdir(), "symnav-daemon-command-state-"));
  readonly workspaceRoot = mkdtempSync(join(tmpdir(), "symnav-daemon-command-workspace-"));
  readonly dependencies: ProgramDependencies;
  private readonly stdout = new PassThrough();
  private readonly stderr = new PassThrough();

  constructor() {
    mkdirSync(join(this.workspaceRoot, ".git"));
    this.dependencies = createDefaultDependencies(
      this.stateDirectory,
      DaemonPolicy.fromSystemMemory({ totalBytes: 512 * 1024 * 1024 }),
    );
  }

  async run(argumentsAfterProgramName: readonly string[]): Promise<{
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode?: number;
  }> {
    const program = new CommanderCommand();
    const context: ProgramContext = {
      stdout: this.stdout,
      stderr: this.stderr,
      cwd: this.workspaceRoot,
      exit: (exitCode) => {
        throw new CommandExit(exitCode);
      },
    };
    registerDaemonCommand(program, context, this.dependencies);
    let exitCode: number | undefined;
    try {
      await program.parseAsync([...argumentsAfterProgramName], { from: "user" });
    } catch (error) {
      if (!(error instanceof CommandExit)) throw error;
      exitCode = error.exitCode;
    }
    return {
      stdout: this.read(this.stdout),
      stderr: this.read(this.stderr),
      ...(exitCode === undefined ? {} : { exitCode }),
    };
  }

  dispose(): void {
    this.stdout.destroy();
    this.stderr.destroy();
    rmSync(this.stateDirectory, { recursive: true, force: true });
    rmSync(this.workspaceRoot, { recursive: true, force: true });
  }

  private read(stream: PassThrough): string {
    return stream.read()?.toString() ?? "";
  }
}

describe("registerDaemonCommand", () => {
  const harnesses: DaemonCommandHarness[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const harness of harnesses.splice(0)) harness.dispose();
  });

  it.each([
    [false, "renderStartText", "start text bytes\u0000\n"],
    [true, "renderStartJson", "start json bytes\u0000\n"],
  ] as const)("writes unchanged start renderer bytes with json=%s", async (json, method, bytes) => {
    const harness = new DaemonCommandHarness();
    harnesses.push(harness);
    const result = {
      status: "ready",
      workspaceRoot: harness.workspaceRoot,
      fileCount: 1,
      loadDurationMs: 2,
    } as const;
    vi.spyOn(DaemonController.prototype, "start").mockResolvedValue(result);
    const render = vi.spyOn(DaemonLifecycleRenderer, method).mockReturnValue(bytes);

    const output = await harness.run(["daemon", "start", ...(json ? ["--json"] : [])]);

    expect(render).toHaveBeenCalledWith(result);
    expect(output).toEqual({ stdout: bytes, stderr: "" });
  });

  it.each([
    [false, "renderStatusText", "status text bytes\u0000\n"],
    [true, "renderStatusJson", "status json bytes\u0000\n"],
  ] as const)(
    "writes unchanged status renderer bytes with json=%s",
    async (json, method, bytes) => {
      const harness = new DaemonCommandHarness();
      harnesses.push(harness);
      const results = [
        { state: "starting", workspaceRoot: harness.workspaceRoot, pid: 11, startupElapsedMs: 12 },
      ] as const;
      vi.spyOn(DaemonController.prototype, "status").mockResolvedValue(results);
      const render = vi.spyOn(DaemonLifecycleRenderer, method).mockReturnValue(bytes);

      const output = await harness.run(["daemon", "status", ...(json ? ["--json"] : [])]);

      expect(render).toHaveBeenCalledWith(results);
      expect(output).toEqual({ stdout: bytes, stderr: "" });
    },
  );

  it.each([
    [false, "renderStopText", "stop text bytes\u0000\n"],
    [true, "renderStopJson", "stop json bytes\u0000\n"],
  ] as const)("writes unchanged stop renderer bytes with json=%s", async (json, method, bytes) => {
    const harness = new DaemonCommandHarness();
    harnesses.push(harness);
    const result = { status: "stopped", workspaceRoot: harness.workspaceRoot, pid: 11 } as const;
    vi.spyOn(DaemonController.prototype, "stop").mockResolvedValue(result);
    const render = vi.spyOn(DaemonLifecycleRenderer, method).mockReturnValue(bytes);

    const output = await harness.run(["daemon", "stop", ...(json ? ["--json"] : [])]);

    expect(render).toHaveBeenCalledWith(result);
    expect(output).toEqual({ stdout: bytes, stderr: "" });
  });

  it.each([
    ["start", "Cannot start daemon: broken\n"],
    ["stop", "Cannot stop daemon: broken\n"],
  ] as const)("preserves %s failure wording and exit code", async (command, errorOutput) => {
    const harness = new DaemonCommandHarness();
    harnesses.push(harness);
    vi.spyOn(DaemonController.prototype, command).mockRejectedValue(new Error("broken"));

    const output = await harness.run(["daemon", command]);

    expect(output).toEqual({ stdout: "", stderr: errorOutput, exitCode: 2 });
  });
});
