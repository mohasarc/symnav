import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe } from "vitest";
import type { CliExecutionRequest, CommandExecutionResult } from "../command-execution-result.js";
import type { ProgramDependencies } from "../program-dependencies.js";
import { DaemonCommandDispatcher } from "./daemon-command-dispatcher.js";
import { DaemonRegistry } from "./daemon-registry.js";
import { DaemonStartupCoordinator } from "./daemon-startup-coordinator.js";
import { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";
import { LocalDaemonTransport } from "./local-daemon-transport.js";

const request = {
  argv: ["overview", "input.ts"],
  cwd: "/repo",
  telemetryEnabled: false,
} as const;
const coldResult: CommandExecutionResult = {
  frames: [{ stream: "stdout", bytesBase64: Buffer.from("cold\n").toString("base64") }],
  exitCode: 0,
};

describe("DaemonCommandDispatcher real failure boundaries", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });
});

function createRuntime(roots: string[]) {
  const stateDirectory = mkdtempSync(join(tmpdir(), "symnav-dispatch-failure-"));
  roots.push(stateDirectory);
  const identity = DaemonWorkspaceIdentity.from("/repo", stateDirectory);
  return {
    identity,
    registry: new DaemonRegistry(identity.registryDirectory),
    transport: new LocalDaemonTransport({ requestTimeoutMs: 50 }),
    stateDirectory,
  };
}

function dispatcher(
  runtime: ReturnType<typeof createRuntime>,
  coordinator: { ensureRunning(identity: DaemonWorkspaceIdentity): Promise<unknown> },
  coldExecute: (request: CliExecutionRequest) => Promise<CommandExecutionResult>,
): DaemonCommandDispatcher {
  return new DaemonCommandDispatcher({
    createDependencies: () =>
      ({
        symnavVersion: "0.1.0",
        recorder: { record: () => {} },
      }) as unknown as ProgramDependencies,
    stateDirectory: runtime.stateDirectory,
    resolveWorkspaceRoot: async () => "/repo",
    runtimeFactory: () => ({ ...runtime, coordinator }),
    executorFactory: () => ({ execute: coldExecute }),
    requestId: () => "expected-request",
  });
}
