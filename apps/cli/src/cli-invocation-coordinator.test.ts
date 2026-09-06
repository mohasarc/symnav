import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DaemonClient, DaemonClientExecuteRequest, DaemonCommandName } from "@symnav/daemon";
import { CliInvocationCoordinator } from "./cli-invocation-coordinator.js";
import { CommandOutputSnapshot, type CliExecutionRequest } from "./command-execution-result.js";

const cwd = resolve("synthetic-workspace", "nested");
const workspaceRoot = resolve("synthetic-workspace");
const result = { output: new CommandOutputSnapshot([]), exitCode: 0 };

describe("CliInvocationCoordinator", () => {
  it.each([
    { argv: ["--help"], commandName: "help" },
    { argv: ["--version"], commandName: "version" },
    { argv: ["unknown"], commandName: "unknown" },
    { argv: ["daemon", "unknown"], commandName: "unknown" },
    { argv: ["daemon", "status"], commandName: "unknown" },
  ] satisfies readonly { readonly argv: readonly string[]; readonly commandName: DaemonCommandName }[])(
    "executes local invocation $argv cold without discovering a workspace",
    async ({ argv }) => {
      const harness = new CoordinatorHarness();
      const request = executionRequest(argv);

      await expect(harness.coordinator.execute(request)).resolves.toEqual({ mode: "cold", result });

      expect(harness.localExecute).toHaveBeenCalledWith({ ...request, executionMode: "cold" });
      expect(harness.resolveWorkspaceRoot).not.toHaveBeenCalled();
      expect(harness.clientExecute).not.toHaveBeenCalled();
    },
  );

  it.each([
    "overview",
    "resolve",
    "def",
    "refs",
    "context",
    "graph",
    "stats",
  ] satisfies readonly DaemonCommandName[])(
    "sends exact resolved %s invocation to the public daemon client",
    async (commandName) => {
      const harness = new CoordinatorHarness();
      const request = executionRequest(["--cwd", "..", commandName, "target"], true);

      await expect(harness.coordinator.execute(request)).resolves.toEqual({ mode: "warm", result });

      expect(harness.resolveWorkspaceRoot).toHaveBeenCalledWith(workspaceRoot);
      expect(harness.clientExecute).toHaveBeenCalledWith({
        workspaceRoot,
        commandName,
        argv: ["--cwd", workspaceRoot, commandName, "target"],
        cwd,
        telemetryEnabled: true,
      });
      expect(harness.localExecute).not.toHaveBeenCalled();
    },
  );

  it("falls back to ordinary cold execution after workspace discovery fails", async () => {
    const harness = new CoordinatorHarness();
    harness.resolveWorkspaceRoot.mockRejectedValueOnce(new Error("not a workspace"));
    harness.localExecute.mockResolvedValueOnce({
      output: new CommandOutputSnapshot([{ stream: "stderr", bytes: Buffer.from("normal error\n") }]),
      exitCode: 1,
    });
    const request = executionRequest(["--cwd", "..", "overview", "missing.ts"], true);

    const execution = await harness.coordinator.execute(request);

    expect(execution).toMatchObject({ mode: "cold", result: { exitCode: 1 } });
    expect(harness.localExecute).toHaveBeenCalledWith({
      ...request,
      argv: ["--cwd", workspaceRoot, "overview", "missing.ts"],
      executionMode: "cold",
    });
    expect(harness.clientExecute).not.toHaveBeenCalled();
  });
});

class CoordinatorHarness {
  readonly clientExecute = vi.fn<(request: DaemonClientExecuteRequest) => Promise<{ mode: "warm"; result: typeof result }>>(async () => ({ mode: "warm", result }));
  readonly localExecute = vi.fn(async () => result);
  readonly resolveWorkspaceRoot = vi.fn(async () => workspaceRoot);
  readonly coordinator = new CliInvocationCoordinator({
    daemonClient: { execute: this.clientExecute } as unknown as DaemonClient,
    createLocalExecutor: () => ({ execute: this.localExecute }),
    resolveWorkspaceRoot: this.resolveWorkspaceRoot,
  });
}

function executionRequest(argv: readonly string[], telemetryEnabled = false): CliExecutionRequest {
  return { argv, cwd, telemetryEnabled };
}
