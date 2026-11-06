import { join, resolve } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { InMemoryFileSystem, type OverviewFileEntries } from "@symnav/core";
import type { ProgramContext } from "./program-context.js";
import type { DaemonExecutorExecutionResult } from "@symnav/daemon";
import type { CliInvocationCoordinator } from "./cli-invocation-coordinator.js";
import { CliProgramExecutor, CommandResultReplayer } from "./cli-program-executor.js";
import { CliInvocationRunner } from "./cli-invocation-runner.js";
import { fakeDependencies } from "../test/integration/commands/helpers/fake-program-dependencies.js";
import { FakeLanguageBackend } from "../test/integration/commands/helpers/fake-language-backend.js";
import { createFakeProgramContext } from "../test/integration/commands/helpers/fake-program-context.js";
import { CommandOutputSnapshot, type CliExecutionRequest } from "./command-execution-result.js";

class RunnerHarness {
  public static coordinator(execute = vi.fn()): CliInvocationCoordinator {
    return { execute } as unknown as CliInvocationCoordinator;
  }
}

describe("CliInvocationRunner", () => {
  it("returns above inline capacity without disk capture or calling the daemon coordinator", async () => {
    const entries: OverviewFileEntries = {
      file: "src/a.ts",
      entries: [],
      diagnostics: [{ severity: "warning", dedupeKey: "large", message: "x".repeat(300_000) }],
    };
    const execute = vi.fn();
    const dependencies = fakeDependencies({
      daemonEnabled: false,
      backends: () => [new FakeLanguageBackend({ entries: () => entries })],
    });
    const context = createFakeProgramContext({ cwd: "/repo" });
    const runner = new CliInvocationRunner({
      dependencies,
      coordinator: RunnerHarness.coordinator(execute),
    });
    await expect(
      runner.run(
        { argv: ["overview", "src/a.ts"], cwd: "/repo", telemetryEnabled: false },
        context,
      ),
    ).resolves.toBe(0);
    expect(context.stderr.text()).toBe(`Warning: ${"x".repeat(300_000)}\n`);
    expect(context.stdout.text()).toBe("Overview: src/a.ts\n(no symbols)\n");
    expect(execute).not.toHaveBeenCalled();
    expect(context.exitCodes).toEqual([]);
  });

  it.each([
    [["overview", "missing.ts"], 1],
    [["--unknown"], 1],
    [["--help"], 0],
  ] as const)("returns controlled exit for %j after writing output", async (argv, exitCode) => {
    const dependencies = fakeDependencies({ daemonEnabled: false });
    const context = createFakeProgramContext({ cwd: "/repo" });
    const runner = new CliInvocationRunner({
      dependencies,
      coordinator: RunnerHarness.coordinator(),
    });
    await expect(
      runner.run({ argv, cwd: "/repo", telemetryEnabled: false }, context),
    ).resolves.toBe(exitCode);
    expect(context.exitCodes).toEqual([]);
  });

  it("normalizes the final relative cwd before direct execution", async () => {
    const workspaceRoot = resolve("/repo");
    const nestedDirectory = join(workspaceRoot, "nested");
    const fileSystemRoot = workspaceRoot.replaceAll("\\", "/");
    const dependencies = fakeDependencies({
      daemonEnabled: false,
      fs: new InMemoryFileSystem({
        [`${fileSystemRoot}/.git/HEAD`]: "ref: refs/heads/main\n",
        [`${fileSystemRoot}/src/a.ts`]: "export const x = 1;",
      }),
    });
    const context = createFakeProgramContext({ cwd: nestedDirectory });
    const runner = new CliInvocationRunner({
      dependencies,
      coordinator: RunnerHarness.coordinator(),
    });
    await expect(
      runner.run(
        {
          argv: ["--cwd=../ignored", "--cwd", "..", "overview", "src/a.ts"],
          cwd: nestedDirectory,
          telemetryEnabled: false,
        },
        context,
      ),
    ).resolves.toBe(0);
    expect(context.stdout.text()).toBe("Overview: src/a.ts\n(no symbols)\n");
    expect(context.stderr.text()).toBe("");
  });

  it("waits for direct output callbacks before returning", async () => {
    let written = false;
    const stdout = new Writable({
      highWaterMark: 1,
      write(_bytes, _encoding, callback) {
        setTimeout(() => {
          written = true;
          callback();
        }, 20);
      },
    });
    const dependencies = fakeDependencies({ daemonEnabled: false });
    const context: ProgramContext = { ...createFakeProgramContext({ cwd: "/repo" }), stdout };
    const runner = new CliInvocationRunner({
      dependencies,
      coordinator: RunnerHarness.coordinator(),
    });
    await runner.run({ argv: ["--version"], cwd: "/repo", telemetryEnabled: false }, context);
    expect(written).toBe(true);
    expect(stdout.writableEnded).toBe(false);
  });

  it("retains the response-capacity policy without spilling direct output", async () => {
    const dependencies = fakeDependencies({ daemonEnabled: false });
    const values = dependencies.daemonPolicy.values;
    const policy = {
      values: { ...values, output: { ...values.output, maximumResultRawBytes: 1 } },
    } as typeof dependencies.daemonPolicy;
    const context = createFakeProgramContext({ cwd: "/repo" });
    const runner = new CliInvocationRunner({
      dependencies: { ...dependencies, daemonPolicy: policy },
      coordinator: RunnerHarness.coordinator(),
    });
    await expect(
      runner.run({ argv: ["--version"], cwd: "/repo", telemetryEnabled: false }, context),
    ).resolves.toBe(1);
    expect(context.stdout.text()).toBe("");
    expect(context.stderr.text()).toBe("Cannot answer: daemon response capacity exceeded.\n");
  });

  it("replaces earlier output when a later write crosses capacity, matching captured execution", async () => {
    const dependencies = fakeDependencies({
      daemonEnabled: false,
      backends: () => [
        new FakeLanguageBackend({
          entries: () => ({
            file: "src/a.ts",
            entries: [],
            diagnostics: [{ severity: "warning", dedupeKey: "probe", message: "probe" }],
          }),
        }),
      ],
    });
    const values = dependencies.daemonPolicy.values;
    const boundedDependencies: typeof dependencies = {
      ...dependencies,
      daemonPolicy: {
        values: { ...values, output: { ...values.output, maximumResultRawBytes: 30 } },
      } as typeof dependencies.daemonPolicy,
    };
    const request: CliExecutionRequest = {
      argv: ["overview", "src/a.ts"],
      cwd: "/repo",
      telemetryEnabled: false,
    };
    const directContext = createFakeProgramContext({ cwd: "/repo" });
    const capturedContext = createFakeProgramContext({ cwd: "/repo" });
    const runner = new CliInvocationRunner({
      dependencies: boundedDependencies,
      coordinator: RunnerHarness.coordinator(),
    });
    const directExitCode = await runner.run(request, directContext);
    const captured = await new CliProgramExecutor(boundedDependencies).execute(request);
    await CommandResultReplayer.replay(captured, capturedContext);
    expect(directExitCode).toBe(captured.exitCode);
    expect(directContext.stdout.text()).toBe(capturedContext.stdout.text());
    expect(directContext.stderr.text()).toBe(capturedContext.stderr.text());
    expect(directContext.stdout.text()).toBe("");
    expect(directContext.stderr.text()).toBe("Cannot answer: daemon response capacity exceeded.\n");
  });

  it("replays routed output and returns its failure without exiting", async () => {
    const result: DaemonExecutorExecutionResult = {
      exitCode: 7,
      output: new CommandOutputSnapshot([
        { stream: "stderr" as const, bytes: Buffer.from("failure\n") },
      ]),
    };
    const execute = vi.fn(async () => ({ mode: "warm", result }));
    const context = createFakeProgramContext({ cwd: "/repo" });
    const runner = new CliInvocationRunner({
      dependencies: fakeDependencies(),
      coordinator: RunnerHarness.coordinator(execute),
    });
    await expect(
      runner.run(
        { argv: ["overview", "src/a.ts"], cwd: "/repo", telemetryEnabled: false },
        context,
      ),
    ).resolves.toBe(7);
    expect(context.stderr.text()).toBe("failure\n");
    expect(context.exitCodes).toEqual([]);
  });
});
