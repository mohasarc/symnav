import { describe, expect, it, vi } from "vitest";
import { DaemonClient, DaemonPolicy, type DaemonExecutor } from "@symnav/daemon";
import { CommandOutputSnapshot } from "../../test/helpers/executor-output.js";

describe("public DaemonClient", () => {
  it("loads its package runtime and delegates execution and control", async () => {
    const execute = vi.fn(async () => ({ exitCode: 0, output: new CommandOutputSnapshot([]) }));
    const executorFactory = vi.fn(
      (): DaemonExecutor => ({
        initialize: async () => ({ fileCount: 0 }),
        execute,
        releaseTransientResources: async () => undefined,
      }),
    );
    const client = new DaemonClient({
      stateDirectory: "/state",
      productVersion: "0.1.0",
      daemonEnabled: false,
      executorFactory,
      executorModuleUrl: "file:///executor.js",
      readinessProbe: { commandName: "version", argv: ["--version"] },
      policy: DaemonPolicy.currentSystem(),
    });

    await expect(
      client.execute({
        workspaceRoot: "/workspace",
        commandName: "overview",
        argv: ["overview", "src/a.ts"],
        cwd: "/workspace",
        telemetryEnabled: false,
      }),
    ).resolves.toMatchObject({ mode: "cold", result: { exitCode: 0 } });
    await expect(client.control({ action: "start", workspaceRoot: "/workspace" })).resolves.toEqual(
      { status: "disabled" },
    );

    expect(executorFactory).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ executionMode: "cold", telemetryEnabled: false }),
    );
  });
});
