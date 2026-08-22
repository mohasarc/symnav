import { describe, expect, it, vi } from "vitest";
import type { CliExecutionRequest, CommandExecutionResult } from "../command-execution-result.js";
import type { ProgramDependencies } from "../program-dependencies.js";
import { DaemonCommandDispatcher } from "./daemon-command-dispatcher.js";

const request: CliExecutionRequest = {
  argv: ["overview", "src/a.ts"],
  cwd: "/repo",
  telemetryEnabled: false,
};
const success: CommandExecutionResult = {
  frames: [{ stream: "stdout", bytesBase64: Buffer.from("answer\n").toString("base64") }],
  exitCode: 0,
};

describe("DaemonCommandDispatcher", () => {
  it("does not touch daemon state when disabled", async () => {
    const runtimeFactory = vi.fn();
    const coldExecute = vi.fn(async () => success);
    const dispatcher = new DaemonCommandDispatcher({
      createDependencies: () => ({}) as ProgramDependencies,
      daemonEnabled: () => false,
      stateDirectory: "/state",
      runtimeFactory,
      executorFactory: () => ({ execute: coldExecute }),
    });

    await expect(dispatcher.execute(request)).resolves.toEqual({
      mode: "cold",
      result: success,
    });
    expect(runtimeFactory).not.toHaveBeenCalled();
    expect(coldExecute).toHaveBeenCalledWith(expect.objectContaining({ executionMode: "cold" }));
  });
});
