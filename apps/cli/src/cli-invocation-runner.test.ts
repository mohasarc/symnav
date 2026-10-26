import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { InMemoryFileSystem, type OverviewFileEntries } from "@symnav/core";
import type { ProgramContext } from "./program-context.js";
import type {
  DaemonClient,
  DaemonControlRequest,
  DaemonExecutorExecutionResult,
} from "@symnav/daemon";
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
  it.each([
    [["overview", "src/a.ts"], 0],
    [["overview", "missing.ts"], 1],
    [["overview", "src/a.ts", "--unknown"], 1],
  ] as const)(
    "appends the exact state warning after ordinary output for %j",
    async (argv, expectedExit) => {
      const directory = await mkdtemp(join(tmpdir(), "symnav-trailing-warning-"));
      try {
        const stateDirectory = join(directory, "state");
        await writeFile(stateDirectory, "blocked");
        const context = createFakeProgramContext({ cwd: "/repo" });
        const runner = new CliInvocationRunner({
          dependencies: fakeDependencies({ stateDirectory }),
          coordinator: RunnerHarness.coordinator(),
        });
        expect(await runner.run({ argv, cwd: "/repo", telemetryEnabled: true }, context)).toBe(
          expectedExit,
        );
        const warning = `symnav: warning: cannot write ${stateDirectory} (EEXIST); daemon and telemetry are off for this command. Grant access with 'symnav setup <agent>', or pass --no-warnings.\n`;
        expect(context.stderr.text().endsWith(warning)).toBe(true);
        expect(context.stderr.text().split("symnav: warning:")).toHaveLength(2);
        expect(context.exitCodes).toEqual([]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("warns once after an accepted failure without invoking local execution", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "symnav-accepted-warning-"));
    try {
      const result: DaemonExecutorExecutionResult = {
        exitCode: 7,
        output: new CommandOutputSnapshot([
          { stream: "stderr" as const, bytes: Buffer.from("ordinary failure\n") },
        ]),
        stateWriteFailure: { path: join(stateDirectory, "usage.jsonl"), osCode: "EPERM" },
      };
      const execute = vi.fn(async (request: CliExecutionRequest) => {
        request.stateWriteFailed?.(result.stateWriteFailure!);
        request.stateWriteFailed?.({ path: "later", osCode: "EIO" });
        return { mode: "warm", result };
      });
      const context = createFakeProgramContext({ cwd: "/repo" });
      const runner = new CliInvocationRunner({
        dependencies: fakeDependencies({ stateDirectory }),
        coordinator: RunnerHarness.coordinator(execute),
      });
      expect(
        await runner.run(
          { argv: ["overview", "src/a.ts"], cwd: "/repo", telemetryEnabled: false },
          context,
        ),
      ).toBe(7);
      expect(context.stderr.text()).toBe(
        `ordinary failure\nsymnav: warning: cannot write ${stateDirectory} (EPERM); daemon and telemetry are off for this command. Grant access with 'symnav setup <agent>', or pass --no-warnings.\n`,
      );
      expect(execute).toHaveBeenCalledTimes(1);
      expect(context.stdout.text()).toBe("");
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it.each([true, false])(
    "preserves lifecycle rejection semantics and finalizes only observed state failures (%s)",
    async (observed) => {
      const stateDirectory = await mkdtemp(join(tmpdir(), "symnav-rejected-lifecycle-"));
      try {
        const failure = new Error("lifecycle cleanup denied");
        const control = vi.fn(async (request: DaemonControlRequest) => {
          if (observed) {
            request.stateWriteFailed?.({
              path: join(stateDirectory, "stale.json"),
              osCode: "EACCES",
            });
          }
          throw failure;
        });
        const execute = vi.fn();
        const context = createFakeProgramContext({ cwd: "/repo" });
        const runner = new CliInvocationRunner({
          dependencies: fakeDependencies({
            stateDirectory,
            daemonClient: { control } as unknown as DaemonClient,
          }),
          coordinator: RunnerHarness.coordinator(execute),
        });
        const completion = runner.run(
          { argv: ["daemon", "status", "--json"], cwd: "/repo", telemetryEnabled: false },
          context,
        );
        if (observed) {
          expect(await completion).toBe(1);
          expect(context.stderr.text()).toContain(failure.stack);
          expect(
            context.stderr
              .text()
              .endsWith(
                `symnav: warning: cannot write ${stateDirectory} (EACCES); daemon and telemetry are off for this command. Grant access with 'symnav setup <agent>', or pass --no-warnings.\n`,
              ),
          ).toBe(true);
          expect(context.stderr.text().split("symnav: warning:")).toHaveLength(2);
        } else {
          await expect(completion).rejects.toBe(failure);
          expect(context.stderr.text()).toBe("");
        }
        expect(control).toHaveBeenCalledTimes(1);
        expect(execute).not.toHaveBeenCalled();
        expect(context.stdout.text()).toBe("");
        expect(context.exitCodes).toEqual([]);
      } finally {
        await rm(stateDirectory, { recursive: true, force: true });
      }
    },
  );

  it("executes locally exactly once without telemetry after required state preparation fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "symnav-runner-denied-"));
    try {
      const stateDirectory = join(directory, "state");
      await writeFile(stateDirectory, "blocked");
      const execute = vi.fn();
      const record = vi.fn();
      const resolve = vi.fn();
      const compute = vi.fn(() => ({ file: "src/a.ts", entries: [] }));
      const runner = new CliInvocationRunner({
        dependencies: fakeDependencies({
          stateDirectory,
          recorder: { record },
          identity: { resolve },
          backends: () => [new FakeLanguageBackend({ entries: compute })],
        }),
        coordinator: RunnerHarness.coordinator(execute),
      });
      const context = createFakeProgramContext({ cwd: "/repo" });
      expect(
        await runner.run(
          { argv: ["overview", "src/a.ts"], cwd: "/repo", telemetryEnabled: true },
          context,
        ),
      ).toBe(0);
      expect(context.stdout.text()).toBe("Overview: src/a.ts\n(no symbols)\n");
      expect(compute).toHaveBeenCalledTimes(1);
      expect(execute).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

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

  it.each(["overview", "stats"])(
    "replays routed %s output and returns its failure without exiting",
    async (commandName) => {
      const stateDirectory = await mkdtemp(join(tmpdir(), "symnav-runner-state-"));
      const result: DaemonExecutorExecutionResult = {
        exitCode: 7,
        output: new CommandOutputSnapshot([
          { stream: "stderr" as const, bytes: Buffer.from("failure\n") },
        ]),
      };
      const execute = vi.fn(async () => ({ mode: "warm", result }));
      const context = createFakeProgramContext({ cwd: "/repo" });
      const runner = new CliInvocationRunner({
        dependencies: fakeDependencies({ stateDirectory }),
        coordinator: RunnerHarness.coordinator(execute),
      });
      await expect(
        runner.run(
          {
            argv: [commandName, ...(commandName === "stats" ? [] : ["src/a.ts"])],
            cwd: "/repo",
            telemetryEnabled: commandName === "stats",
          },
          context,
        ),
      ).resolves.toBe(7);
      expect(context.stderr.text()).toBe("failure\n");
      await rm(stateDirectory, { recursive: true, force: true });
      expect(context.exitCodes).toEqual([]);
    },
  );
});
