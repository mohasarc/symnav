import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Command as CommanderCommand } from "commander";
import { DaemonPolicy } from "@symnav/daemon";
import type {
  DaemonClient,
  DaemonControlRequest,
  DaemonStartResult,
  DaemonStopResult,
  RunningDaemonStatus,
} from "@symnav/daemon";
import { DaemonLifecycleRenderer } from "@symnav/renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultDependencies } from "../../program.js";
import type { ProgramContext } from "../../program-context.js";
import type { ProgramDependencies } from "../../program-dependencies.js";
import { registerDaemonCommand } from "./register-daemon-command.js";

class CommandExit extends Error {
  constructor(readonly exitCode: number) {
    super();
  }
}

type ControlResult = DaemonStartResult | readonly RunningDaemonStatus[] | DaemonStopResult;

class DaemonCommandHarness {
  readonly stateDirectory = mkdtempSync(join(tmpdir(), "symnav-daemon-command-state-"));
  readonly workspaceRoot = mkdtempSync(join(tmpdir(), "symnav-daemon-command-workspace-"));
  readonly clientDirectory = join(this.workspaceRoot, "nested");
  readonly control = vi.fn<(request: DaemonControlRequest) => Promise<ControlResult>>();
  readonly dependencies: ProgramDependencies;
  private readonly stdout = new PassThrough();
  private readonly stderr = new PassThrough();

  constructor(daemonEnabled = true) {
    mkdirSync(join(this.workspaceRoot, ".git"));
    mkdirSync(this.clientDirectory);
    this.dependencies = {
      ...createDefaultDependencies(
        this.stateDirectory,
        DaemonPolicy.fromSystemMemory({ totalBytes: 512 * 1024 * 1024 }),
        daemonEnabled,
      ),
      daemonClient: { control: this.control } as unknown as DaemonClient,
      daemonEnabled,
    };
  }

  async run(argumentsAfterProgramName: readonly string[]): Promise<{
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode?: number;
  }> {
    const program = new CommanderCommand().option("--cwd <dir>");
    const context: ProgramContext = {
      stdout: this.stdout,
      stderr: this.stderr,
      cwd: this.clientDirectory,
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
    const harness = createHarness(harnesses);
    const result = {
      status: "ready",
      workspaceRoot: harness.workspaceRoot,
      fileCount: 1,
      loadDurationMs: 2,
    } as const;
    harness.control.mockResolvedValue(result);
    const render = vi.spyOn(DaemonLifecycleRenderer, method).mockReturnValue(bytes);

    const output = await harness.run(["daemon", "start", ...(json ? ["--json"] : [])]);

    expect(harness.control).toHaveBeenCalledWith({ action: "start", workspaceRoot: harness.workspaceRoot });
    expect(render).toHaveBeenCalledWith(result);
    expect(output).toEqual({ stdout: bytes, stderr: "" });
  });

  it.each([
    [false, "renderStatusText", "status text bytes\u0000\n"],
    [true, "renderStatusJson", "status json bytes\u0000\n"],
  ] as const)("writes unchanged status renderer bytes with json=%s", async (json, method, bytes) => {
    const harness = createHarness(harnesses, false);
    const results = [
      { state: "starting", workspaceRoot: harness.workspaceRoot, pid: 11, startupElapsedMs: 12 },
    ] as const;
    harness.control.mockResolvedValue(results);
    const render = vi.spyOn(DaemonLifecycleRenderer, method).mockReturnValue(bytes);

    const output = await harness.run(["daemon", "status", ...(json ? ["--json"] : [])]);

    expect(harness.control).toHaveBeenCalledWith({ action: "status" });
    expect(render).toHaveBeenCalledWith(results);
    expect(output).toEqual({ stdout: bytes, stderr: "" });
  });

  it.each([
    [false, "renderStopText", "stop text bytes\u0000\n"],
    [true, "renderStopJson", "stop json bytes\u0000\n"],
  ] as const)("writes unchanged stop renderer bytes with json=%s", async (json, method, bytes) => {
    const harness = createHarness(harnesses, false);
    const result = { status: "stopped", workspaceRoot: harness.workspaceRoot, pid: 11 } as const;
    harness.control.mockResolvedValue(result);
    const render = vi.spyOn(DaemonLifecycleRenderer, method).mockReturnValue(bytes);

    const output = await harness.run(["daemon", "stop", ...(json ? ["--json"] : [])]);

    expect(harness.control).toHaveBeenCalledWith({ action: "stop", workspaceRoot: harness.workspaceRoot });
    expect(render).toHaveBeenCalledWith(result);
    expect(output).toEqual({ stdout: bytes, stderr: "" });
  });

  it.each(["start", "stop"] as const)(
    "resolves relative --cwd for daemon %s from the requesting client directory",
    async (command) => {
      const harness = createHarness(harnesses);
      harness.control.mockResolvedValue(
        command === "start"
          ? {
              status: "ready",
              workspaceRoot: harness.workspaceRoot,
              fileCount: 1,
              loadDurationMs: 2,
            }
          : { status: "stopped", workspaceRoot: harness.workspaceRoot },
      );

      await harness.run(["--cwd", "..", "daemon", command]);

      expect(harness.control).toHaveBeenCalledWith({
        action: command,
        workspaceRoot: harness.workspaceRoot,
      });
    },
  );

  it("reports disabled start before workspace discovery", async () => {
    const harness = createHarness(harnesses, false);
    rmSync(harness.workspaceRoot, { recursive: true, force: true });

    const output = await harness.run(["daemon", "start"]);

    expect(output).toEqual({
      stdout: "",
      stderr: "Daemon disabled by SYMNAV_DAEMON=0\n",
      exitCode: 1,
    });
    expect(harness.control).not.toHaveBeenCalled();
  });

  it.each([
    ["start", "Cannot start daemon: broken\n"],
    ["stop", "Cannot stop daemon: broken\n"],
  ] as const)("preserves %s failure wording and exit code", async (command, errorOutput) => {
    const harness = createHarness(harnesses);
    harness.control.mockRejectedValue(new Error("broken"));

    const output = await harness.run(["daemon", command]);

    expect(output).toEqual({ stdout: "", stderr: errorOutput, exitCode: 2 });
  });
});

function createHarness(
  harnesses: DaemonCommandHarness[],
  daemonEnabled = true,
): DaemonCommandHarness {
  const harness = new DaemonCommandHarness(daemonEnabled);
  harnesses.push(harness);
  return harness;
}
