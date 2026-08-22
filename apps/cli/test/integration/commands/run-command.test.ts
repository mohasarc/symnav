import { describe, expect, it, vi } from "vitest";
import { TypeScriptBackend, TypeScriptWorkspaceState } from "@symnav/backend-typescript";
import {
  InMemoryFileSystem,
  type FileMetadata,
  type FileSystem,
  type ResultWithDiagnostics,
  type SymbolIdentity,
  UserFacingError,
} from "@symnav/core";
import type { ArgShape } from "@symnav/telemetry";
import { runCommand } from "../../../src/command.js";
import type { Command, CommandContext, CommandInvocation } from "../../../src/command.js";
import {
  createCapturingRecorder,
  createFakeIdentityProvider,
  createScriptedClock,
  fakeDependencies,
} from "./helpers/fake-program-dependencies.js";
import { createFakeProgramContext } from "./helpers/fake-program-context.js";
import { FakeLanguageBackend } from "./helpers/fake-language-backend.js";
import { NavigationDiagnosticsCollector } from "../../../src/commands/navigation-diagnostics-collector.js";

interface StubArgs {
  readonly note: string;
}

interface StubResult extends ResultWithDiagnostics {
  readonly value: string;
}

class StubCommand implements Command<StubResult, StubArgs> {
  readonly name = "stub";

  constructor(
    private readonly options: {
      compute?: (ctx: CommandContext<StubArgs>) => Promise<StubResult>;
      renderText?: (result: StubResult) => string;
      renderJson?: (result: StubResult) => string;
    } = {},
  ) {}

  describeArgs(args: StubArgs): ArgShape {
    return { kind: "bare", lengthBucket: args.note.length === 0 ? "empty" : "short", flags: [] };
  }

  countResults(result: StubResult): Record<string, number> {
    return { length: result.value.length };
  }

  async compute(ctx: CommandContext<StubArgs>): Promise<StubResult> {
    if (this.options.compute) {
      return this.options.compute(ctx);
    }
    return { value: "computed" };
  }

  renderText(result: StubResult): string {
    if (this.options.renderText) {
      return this.options.renderText(result);
    }
    return `text:${result.value}`;
  }

  renderJson(result: StubResult): string {
    if (this.options.renderJson) {
      return this.options.renderJson(result);
    }
    return `json:${result.value}`;
  }
}

const stubArgs = (note: string): StubArgs => ({ note });

describe("runCommand lifecycle", () => {
  it("snapshots and refreshes once before compute reuses workspace files", async () => {
    const context = createFakeProgramContext({ cwd: "/repo" });
    const fs = new CountingFileSystem(
      new InMemoryFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/src/a.ts": "export const x = 1;\n",
        "/repo/src/nested/.gitignore": "ignored.ts\n",
        "/repo/src/nested/b.ts": "export const b = 2;\n",
        "/repo/src/nested/ignored.ts": "export const ignored = 3;\n",
      }),
    );
    const backend = new FakeLanguageBackend({ accept: (filePath) => filePath.endsWith(".ts") });

    await runCommand(
      new StubCommand({
        compute: async (commandContext) => {
          const first = await commandContext.workspace.enumerate();
          const second = await commandContext.workspace.enumerate();
          expect(second).toBe(first);
          return NavigationDiagnosticsCollector.attach<StubResult>(
            { value: "computed" },
            commandContext.workspace,
            commandContext.router,
          );
        },
      }),
      {
        context,
        dependencies: fakeDependencies({ fs, backends: () => [backend] }),
        cwdOverride: undefined,
        json: false,
        args: stubArgs("hi"),
      },
    );

    expect(context.stdout.text()).toBe("text:computed");
    expect(context.stderr.text()).toBe("");
    expect(backend.refreshCalls).toHaveLength(1);
    expect(backend.refreshCalls[0]?.map((file) => file.relative)).toEqual([
      "src/a.ts",
      "src/nested/b.ts",
    ]);
    expect(backend.calls).toEqual(["src/a.ts", "src/nested/b.ts"]);
    expect(fs.directoryReads).toEqual(["async:/repo", "async:/repo/src", "async:/repo/src/nested"]);
    expect(fs.metadataCalls).toEqual([
      "/repo/src/a.ts",
      "/repo/src/nested/.gitignore",
      "/repo/src/nested/b.ts",
    ]);
  });

  it("purges newly ignored files before retained reference and caller queries", async () => {
    const context = createFakeProgramContext({ cwd: "/repo" });
    const fs = new MutableCommandFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/.gitignore": "",
      "/repo/src/a.ts": "export function target(): void {}\n",
      "/repo/src/b.ts": [
        'import { target } from "./a.js";',
        "export function caller(): void { target(); }",
        "",
      ].join("\n"),
    });
    const state = new TypeScriptWorkspaceState(fs);
    const backend = new TypeScriptBackend(fs, state);
    const observations: {
      readonly referenceFiles: readonly string[];
      readonly callerSiteFiles: readonly string[];
    }[] = [];
    const command = new StubCommand({
      compute: async (commandContext) => {
        const typescript = commandContext.router.findOrThrow("src/a.ts");
        const files = (await commandContext.workspace.enumerate()).filter((file) =>
          typescript.accepts(file.relative),
        );
        const identity: SymbolIdentity = {
          file: "src/a.ts",
          segments: [{ name: "target" }],
        };
        const references = await typescript.findReferences(files, identity);
        const callers = await typescript.findCallers(files, identity);
        observations.push({
          referenceFiles: references.map((reference) => reference.file),
          callerSiteFiles: callers.flatMap((caller) => caller.sites.map((site) => site.file)),
        });
        return { value: "computed" };
      },
    });
    const invocation: CommandInvocation<StubArgs> = {
      context,
      dependencies: fakeDependencies({ fs, backends: () => [backend] }),
      cwdOverride: undefined,
      json: false,
      args: stubArgs("hi"),
    };

    await runCommand(command, invocation);
    fs.setFile("/repo/.gitignore", "src/b.ts\n");
    await runCommand(command, invocation);

    expect(observations).toEqual([
      {
        referenceFiles: ["src/b.ts", "src/b.ts"],
        callerSiteFiles: ["src/b.ts"],
      },
      { referenceFiles: [], callerSiteFiles: [] },
    ]);
    expect(state.currentFileCount()).toBe(1);
    expect(state.sourceFile("src/b.ts")).toBeUndefined();
  });

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

  it("writes result diagnostics to stderr before stdout", async () => {
    const context = createFakeProgramContext({ cwd: "/repo" });

    await runCommand(
      new StubCommand({
        compute: async () => ({
          value: "computed",
          diagnostics: [
            { severity: "warning", dedupeKey: "one", message: "first" },
            { severity: "warning", dedupeKey: "two", message: "second" },
          ],
        }),
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

  it("writes result diagnostics to stderr in json mode too", async () => {
    const context = createFakeProgramContext({ cwd: "/repo" });

    await runCommand(
      new StubCommand({
        compute: async () => ({
          value: "computed",
          diagnostics: [{ severity: "warning", dedupeKey: "one", message: "first" }],
        }),
      }),
      {
        context,
        dependencies: fakeDependencies(),
        cwdOverride: undefined,
        json: true,
        args: stubArgs("hi"),
      },
    );

    expect(context.stderr.text()).toBe("Warning: first\n");
    expect(context.stdout.text()).toBe("json:computed");
  });

  it("passes workspace, router, git, cwd, and args to compute and nothing else", async () => {
    const context = createFakeProgramContext({ cwd: "/repo" });
    const dependencies = fakeDependencies();
    let seen: CommandContext<StubArgs> | undefined;

    await runCommand(
      new StubCommand({
        compute: async (ctx) => {
          seen = ctx;
          return { value: "ok" };
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
          return { value: "ok" };
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

class CountingFileSystem implements FileSystem {
  readonly directoryReads: string[] = [];
  readonly metadataCalls: string[] = [];

  constructor(private readonly inner: InMemoryFileSystem) {}

  readFile(absPath: string): Promise<string> {
    return this.inner.readFile(absPath);
  }

  exists(absPath: string): Promise<boolean> {
    return this.inner.exists(absPath);
  }

  listDir(absPath: string): Promise<readonly string[]> {
    this.directoryReads.push(`async:${absPath}`);
    return this.inner.listDir(absPath);
  }

  isDirectory(absPath: string): Promise<boolean> {
    return this.inner.isDirectory(absPath);
  }

  metadata(absPath: string): Promise<FileMetadata> {
    this.metadataCalls.push(absPath);
    return this.inner.metadata(absPath);
  }

  existsSync(absPath: string): boolean {
    return this.inner.existsSync(absPath);
  }

  readFileSync(absPath: string): string {
    return this.inner.readFileSync(absPath);
  }

  listDirSync(absPath: string): readonly string[] {
    this.directoryReads.push(`sync:${absPath}`);
    return this.inner.listDirSync(absPath);
  }

  isDirectorySync(absPath: string): boolean {
    return this.inner.isDirectorySync(absPath);
  }

  metadataSync(absPath: string): FileMetadata {
    this.metadataCalls.push(absPath);
    return this.inner.metadataSync(absPath);
  }
}

class MutableCommandFileSystem implements FileSystem {
  private readonly contents = new Map<string, string>();
  private readonly modifiedAtByPath = new Map<string, number>();
  private modifiedAtMs = 0;

  constructor(files: Record<string, string>) {
    for (const [path, content] of Object.entries(files)) {
      this.setFile(path, content);
    }
  }

  setFile(path: string, content: string): void {
    this.modifiedAtMs += 1;
    this.contents.set(path, content);
    this.modifiedAtByPath.set(path, this.modifiedAtMs);
  }

  readFile(absPath: string): Promise<string> {
    return Promise.resolve(this.readFileSync(absPath));
  }

  exists(absPath: string): Promise<boolean> {
    return Promise.resolve(this.existsSync(absPath));
  }

  listDir(absPath: string): Promise<readonly string[]> {
    return Promise.resolve(this.listDirSync(absPath));
  }

  isDirectory(absPath: string): Promise<boolean> {
    return Promise.resolve(this.isDirectorySync(absPath));
  }

  metadata(absPath: string): Promise<FileMetadata> {
    return Promise.resolve(this.metadataSync(absPath));
  }

  existsSync(absPath: string): boolean {
    return this.delegate().existsSync(absPath);
  }

  readFileSync(absPath: string): string {
    const content = this.contents.get(absPath);
    if (content === undefined) {
      throw new Error(`ENOENT: no such file: ${absPath}`);
    }
    return content;
  }

  listDirSync(absPath: string): readonly string[] {
    return this.delegate().listDirSync(absPath);
  }

  isDirectorySync(absPath: string): boolean {
    return this.delegate().isDirectorySync(absPath);
  }

  metadataSync(absPath: string): FileMetadata {
    const content = this.readFileSync(absPath);
    return {
      size: Buffer.byteLength(content),
      modifiedAtMs: this.modifiedAtByPath.get(absPath) ?? 0,
    };
  }

  private delegate(): InMemoryFileSystem {
    return new InMemoryFileSystem(Object.fromEntries(this.contents));
  }
}
