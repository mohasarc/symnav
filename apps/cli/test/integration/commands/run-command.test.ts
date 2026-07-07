import { describe, expect, it, vi } from "vitest";
import { InMemoryFileSystem, type NavigationDiagnostic, UserFacingError } from "@symnav/core";
import type { ArgShape } from "@symnav/telemetry";
import { runCommand } from "../../../src/command.js";
import type { Command, CommandContext } from "../../../src/command.js";
import {
  createCapturingRecorder,
  createFakeIdentityProvider,
  createScriptedClock,
  fakeDependencies,
} from "./helpers/fake-program-dependencies.js";
import { createFakeProgramContext } from "./helpers/fake-program-context.js";

interface StubArgs {
  readonly note: string;
}

class StubCommand implements Command<string, StubArgs> {
  readonly name = "stub";

  constructor(
    private readonly options: {
      compute?: (ctx: CommandContext<StubArgs>) => Promise<string>;
      renderText?: (result: string) => string;
      renderJson?: (result: string) => string;
      diagnostics?: (result: string) => readonly NavigationDiagnostic[];
    } = {},
  ) {}

  describeArgs(args: StubArgs): ArgShape {
    return { kind: "bare", lengthBucket: args.note.length === 0 ? "empty" : "short", flags: [] };
  }

  countResults(result: string): Record<string, number> {
    return { length: result.length };
  }

  async compute(ctx: CommandContext<StubArgs>): Promise<string> {
    if (this.options.compute) {
      return this.options.compute(ctx);
    }
    return "computed";
  }

  diagnostics(result: string): readonly NavigationDiagnostic[] {
    return this.options.diagnostics?.(result) ?? [];
  }

  renderText(result: string): string {
    if (this.options.renderText) {
      return this.options.renderText(result);
    }
    return `text:${result}`;
  }

  renderJson(result: string): string {
    if (this.options.renderJson) {
      return this.options.renderJson(result);
    }
    return `json:${result}`;
  }
}

const stubArgs = (note: string): StubArgs => ({ note });

describe("runCommand lifecycle", () => {
  it("writes the rendered text result to stdout on success", async () => {
    const context = createFakeProgramContext({ cwd: "/repo" });

    await runCommand(new StubCommand(), {
      context,
      dependencies: fakeDependencies(),
      cwdOverride: undefined,
      json: false,
      args: stubArgs("hi"),
    });

    expect(context.stdout.text()).toBe("text:computed");
    expect(context.stderr.text()).toBe("");
    expect(context.exitCodes).toEqual([]);
  });

  it("selects renderJson when json is true", async () => {
    const context = createFakeProgramContext({ cwd: "/repo" });

    await runCommand(new StubCommand(), {
      context,
      dependencies: fakeDependencies(),
      cwdOverride: undefined,
      json: true,
      args: stubArgs("hi"),
    });

    expect(context.stdout.text()).toBe("json:computed");
  });

  it("writes diagnostics to stderr before stdout", async () => {
    const context = createFakeProgramContext({ cwd: "/repo" });

    await runCommand(
      new StubCommand({
        diagnostics: () => [
          { severity: "warning", key: "one", message: "Warning: first" },
          { severity: "warning", key: "two", message: "Warning: second" },
        ],
      }),
      {
        context,
        dependencies: fakeDependencies(),
        cwdOverride: undefined,
        json: false,
        args: stubArgs("hi"),
      },
    );

    expect(context.stderr.text()).toBe("Warning: first\nWarning: second\n");
    expect(context.stdout.text()).toBe("text:computed");
    expect(context.exitCodes).toEqual([]);
  });

  it("passes workspace, router, git, cwd, and args to compute and nothing else", async () => {
    const context = createFakeProgramContext({ cwd: "/repo" });
    const dependencies = fakeDependencies();
    let seen: CommandContext<StubArgs> | undefined;

    await runCommand(
      new StubCommand({
        compute: async (ctx) => {
          seen = ctx;
          return "ok";
        },
      }),
      {
        context,
        dependencies,
        cwdOverride: undefined,
        json: false,
        args: stubArgs("hi"),
      },
    );

    expect(seen).toBeDefined();
    expect(Object.keys(seen!).sort()).toEqual(["args", "cwd", "git", "router", "workspace"]);
    expect(seen!.cwd).toBe("/repo");
    expect(seen!.args).toEqual({ note: "hi" });
    expect(seen!.git).toBe(dependencies.git);
  });

  it("writes a Cannot answer line and exits 1 when workspace creation fails", async () => {
    const context = createFakeProgramContext({ cwd: "/loose" });
    const fs = new InMemoryFileSystem({
      "/loose/src/a.ts": "export const x = 1;\n",
    });

    await runCommand(new StubCommand(), {
      context,
      dependencies: fakeDependencies({ fs }),
      cwdOverride: undefined,
      json: false,
      args: stubArgs("hi"),
    });

    expect(context.stdout.text()).toBe("");
    expect(context.stderr.text()).toBe(
      "Cannot answer: not in a git workspace (no .git found in or above /loose).\n",
    );
    expect(context.exitCodes).toEqual([1]);
  });

  it("writes a Cannot answer line and exits 1 when compute throws a UserFacingError", async () => {
    const context = createFakeProgramContext({ cwd: "/repo" });

    class BoomError extends UserFacingError {
      get reason(): string {
        return "something went wrong";
      }
    }

    await runCommand(
      new StubCommand({
        compute: () => {
          throw new BoomError();
        },
      }),
      {
        context,
        dependencies: fakeDependencies(),
        cwdOverride: undefined,
        json: false,
        args: stubArgs("hi"),
      },
    );

    expect(context.stdout.text()).toBe("");
    expect(context.stderr.text()).toBe("Cannot answer: something went wrong.\n");
    expect(context.exitCodes).toEqual([1]);
  });

  it("writes the raw message and exits 2 when compute throws a non-UserFacingError", async () => {
    const context = createFakeProgramContext({ cwd: "/repo" });

    await runCommand(
      new StubCommand({
        compute: () => {
          throw new Error("internal boom");
        },
      }),
      {
        context,
        dependencies: fakeDependencies(),
        cwdOverride: undefined,
        json: false,
        args: stubArgs("hi"),
      },
    );

    expect(context.stdout.text()).toBe("");
    expect(context.stderr.text()).toBe("internal boom\n");
    expect(context.exitCodes).toEqual([2]);
  });

  it("resolves cwd from cwdOverride when provided", async () => {
    const context = createFakeProgramContext({ cwd: "/unrelated" });
    let seenCwd = "";

    await runCommand(
      new StubCommand({
        compute: async (ctx) => {
          seenCwd = ctx.cwd;
          return "ok";
        },
      }),
      {
        context,
        dependencies: fakeDependencies(),
        cwdOverride: "/repo",
        json: false,
        args: stubArgs("hi"),
      },
    );

    expect(seenCwd).toBe("/repo");
    expect(context.exitCodes).toEqual([]);
  });

  it("records one success event when telemetry is enabled", async () => {
    const context = createFakeProgramContext({ cwd: "/repo" });
    const recorder = createCapturingRecorder();

    await runCommand(new StubCommand(), {
      context,
      dependencies: fakeDependencies({
        recorder,
        clock: createScriptedClock([2_000, 2_045]),
        telemetryEnabled: true,
        identity: createFakeIdentityProvider({
          workspaceId: "workspace-123",
          machineId: "machine-123",
        }),
        symnavVersion: "1.2.3",
      }),
      cwdOverride: undefined,
      json: true,
      args: stubArgs("hi"),
    });

    expect(context.stdout.text()).toBe("json:computed");
    expect(context.stderr.text()).toBe("");
    expect(context.exitCodes).toEqual([]);
    expect(recorder.events).toEqual([
      {
        symnavVersion: "1.2.3",
        command: "stub",
        timestamp: 2_000,
        durationMs: 45,
        outcome: "success",
        argShape: { kind: "bare", lengthBucket: "short", flags: ["json"] },
        resultCounts: { length: 8 },
        workspaceId: "workspace-123",
        machineId: "machine-123",
      },
    ]);
  });

  it("records one user error event when compute throws a UserFacingError", async () => {
    const context = createFakeProgramContext({ cwd: "/repo" });
    const recorder = createCapturingRecorder();

    class CannotAnswerError extends UserFacingError {
      get reason(): string {
        return "no answer";
      }
    }

    await runCommand(
      new StubCommand({
        compute: () => {
          throw new CannotAnswerError();
        },
      }),
      {
        context,
        dependencies: fakeDependencies({
          recorder,
          telemetryEnabled: true,
        }),
        cwdOverride: undefined,
        json: false,
        args: stubArgs("hi"),
      },
    );

    expect(context.stdout.text()).toBe("");
    expect(context.stderr.text()).toBe("Cannot answer: no answer.\n");
    expect(context.exitCodes).toEqual([1]);
    expect(recorder.events).toEqual([
      expect.objectContaining({
        command: "stub",
        outcome: "user_error",
        errorReason: "CannotAnswerError",
        argShape: { kind: "bare", lengthBucket: "short", flags: [] },
      }),
    ]);
    expect(recorder.events[0]).not.toHaveProperty("resultCounts");
  });

  it("records one crash event when compute throws a plain Error", async () => {
    const context = createFakeProgramContext({ cwd: "/repo" });
    const recorder = createCapturingRecorder();

    await runCommand(
      new StubCommand({
        compute: () => {
          throw new Error("internal boom");
        },
      }),
      {
        context,
        dependencies: fakeDependencies({
          recorder,
          telemetryEnabled: true,
        }),
        cwdOverride: undefined,
        json: false,
        args: stubArgs("hi"),
      },
    );

    expect(context.stdout.text()).toBe("");
    expect(context.stderr.text()).toBe("internal boom\n");
    expect(context.exitCodes).toEqual([2]);
    expect(recorder.events).toEqual([
      expect.objectContaining({
        command: "stub",
        outcome: "crash",
        errorReason: "crash",
      }),
    ]);
    expect(recorder.events[0]).not.toHaveProperty("resultCounts");
  });

  it("records one crash event when rendering throws", async () => {
    const context = createFakeProgramContext({ cwd: "/repo" });
    const recorder = createCapturingRecorder();

    await runCommand(
      new StubCommand({
        renderText: () => {
          throw new Error("render boom");
        },
      }),
      {
        context,
        dependencies: fakeDependencies({
          recorder,
          telemetryEnabled: true,
        }),
        cwdOverride: undefined,
        json: false,
        args: stubArgs("hi"),
      },
    );

    expect(context.stdout.text()).toBe("");
    expect(context.stderr.text()).toBe("render boom\n");
    expect(context.exitCodes).toEqual([2]);
    expect(recorder.events).toEqual([
      expect.objectContaining({
        command: "stub",
        outcome: "crash",
        errorReason: "crash",
      }),
    ]);
    expect(recorder.events[0]).not.toHaveProperty("resultCounts");
  });

  it("records one crash event when stdout write throws", async () => {
    const context = createFakeProgramContext({ cwd: "/repo" });
    context.stdout.write = (() => {
      throw new Error("write boom");
    }) as typeof context.stdout.write;
    const recorder = createCapturingRecorder();

    await runCommand(new StubCommand(), {
      context,
      dependencies: fakeDependencies({
        recorder,
        telemetryEnabled: true,
      }),
      cwdOverride: undefined,
      json: false,
      args: stubArgs("hi"),
    });

    expect(context.stderr.text()).toBe("write boom\n");
    expect(context.exitCodes).toEqual([2]);
    expect(recorder.events).toEqual([
      expect.objectContaining({
        command: "stub",
        outcome: "crash",
        errorReason: "crash",
      }),
    ]);
    expect(recorder.events[0]).not.toHaveProperty("resultCounts");
  });

  it("records one user error event when workspace creation fails", async () => {
    const context = createFakeProgramContext({ cwd: "/loose" });
    const recorder = createCapturingRecorder();
    const identityResolve = vi.fn(() => ({
      workspaceId: "loose-workspace",
      machineId: "machine-123",
    }));
    const fs = new InMemoryFileSystem({
      "/loose/src/a.ts": "export const x = 1;\n",
    });

    await runCommand(new StubCommand(), {
      context,
      dependencies: fakeDependencies({
        fs,
        recorder,
        telemetryEnabled: true,
        identity: { resolve: identityResolve },
      }),
      cwdOverride: undefined,
      json: false,
      args: stubArgs("hi"),
    });

    expect(context.stdout.text()).toBe("");
    expect(context.stderr.text()).toBe(
      "Cannot answer: not in a git workspace (no .git found in or above /loose).\n",
    );
    expect(context.exitCodes).toEqual([1]);
    expect(identityResolve).toHaveBeenCalledWith({ cwd: "/loose", workspaceRoot: undefined });
    expect(recorder.events).toEqual([
      expect.objectContaining({
        outcome: "user_error",
        errorReason: "NotInWorkspaceError",
        workspaceId: "loose-workspace",
      }),
    ]);
  });

  it("does not build or record telemetry when disabled", async () => {
    const context = createFakeProgramContext({ cwd: "/repo" });
    const record = vi.fn();
    const resolve = vi.fn(() => ({
      workspaceId: "workspace-123",
      machineId: "machine-123",
    }));

    await runCommand(new StubCommand(), {
      context,
      dependencies: fakeDependencies({
        recorder: { record },
        identity: { resolve },
        telemetryEnabled: false,
      }),
      cwdOverride: undefined,
      json: false,
      args: stubArgs("hi"),
    });

    expect(context.stdout.text()).toBe("text:computed");
    expect(context.stderr.text()).toBe("");
    expect(context.exitCodes).toEqual([]);
    expect(record).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("swallows recorder faults without changing command output", async () => {
    const context = createFakeProgramContext({ cwd: "/repo" });

    await runCommand(new StubCommand(), {
      context,
      dependencies: fakeDependencies({
        recorder: {
          record: () => {
            throw new Error("telemetry boom");
          },
        },
        telemetryEnabled: true,
      }),
      cwdOverride: undefined,
      json: false,
      args: stubArgs("hi"),
    });

    expect(context.stdout.text()).toBe("text:computed");
    expect(context.stderr.text()).toBe("");
    expect(context.exitCodes).toEqual([]);
  });

  it("records before exiting on the error path", async () => {
    const order: string[] = [];
    const context = createFakeProgramContext({ cwd: "/repo" });
    context.exit = ((code: number) => {
      order.push(`exit:${code}`);
      return undefined as never;
    }) as typeof context.exit;

    await runCommand(
      new StubCommand({
        compute: () => {
          throw new Error("internal boom");
        },
      }),
      {
        context,
        dependencies: fakeDependencies({
          telemetryEnabled: true,
          recorder: {
            record: () => {
              order.push("record");
            },
          },
        }),
        cwdOverride: undefined,
        json: false,
        args: stubArgs("hi"),
      },
    );

    expect(order).toEqual(["record", "exit:2"]);
  });
});
