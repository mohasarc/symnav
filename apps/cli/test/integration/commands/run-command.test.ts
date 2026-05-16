import { describe, expect, it } from "vitest";
import { InMemoryFileSystem, UserFacingError } from "@symnav/core";
import { runCommand } from "../../../src/command.js";
import type { Command, CommandArgs, CommandContext } from "../../../src/command.js";
import { FakeLanguageBackend } from "./helpers/fake-language-backend.js";
import { createFakeProgramContext } from "./helpers/fake-program-context.js";

class StubCommand implements Command<string> {
  constructor(
    private readonly options: {
      compute?: (ctx: CommandContext) => Promise<string>;
    } = {},
  ) {}

  async compute(ctx: CommandContext): Promise<string> {
    if (this.options.compute) {
      return this.options.compute(ctx);
    }
    return "computed";
  }

  renderText(result: string): string {
    return `text:${result}`;
  }

  renderJson(result: string): string {
    return `json:${result}`;
  }
}

const repoWithFile = (): InMemoryFileSystem =>
  new InMemoryFileSystem({
    "/repo/.git/HEAD": "ref: refs/heads/main\n",
    "/repo/src/a.ts": "export const x = 1;",
  });

const stubArgs = (file: string): CommandArgs => ({ file });

describe("runCommand lifecycle", () => {
  it("writes the rendered text result to stdout on success", async () => {
    const context = createFakeProgramContext({ cwd: "/repo" });

    await runCommand(new StubCommand(), {
      context,
      dependencies: { fs: repoWithFile(), backends: () => [new FakeLanguageBackend()] },
      cwdOverride: undefined,
      json: false,
      args: stubArgs("src/a.ts"),
    });

    expect(context.stdout.text()).toBe("text:computed");
    expect(context.stderr.text()).toBe("");
    expect(context.exitCodes).toEqual([]);
  });

  it("selects renderJson when json is true", async () => {
    const context = createFakeProgramContext({ cwd: "/repo" });

    await runCommand(new StubCommand(), {
      context,
      dependencies: { fs: repoWithFile(), backends: () => [new FakeLanguageBackend()] },
      cwdOverride: undefined,
      json: true,
      args: stubArgs("src/a.ts"),
    });

    expect(context.stdout.text()).toBe("json:computed");
  });

  it("writes a Cannot answer line and exits 1 when workspace creation fails", async () => {
    const context = createFakeProgramContext({ cwd: "/loose" });
    const fs = new InMemoryFileSystem({
      "/loose/src/a.ts": "export const x = 1;\n",
    });

    await runCommand(new StubCommand(), {
      context,
      dependencies: { fs, backends: () => [new FakeLanguageBackend()] },
      cwdOverride: undefined,
      json: false,
      args: stubArgs("src/a.ts"),
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
        dependencies: { fs: repoWithFile(), backends: () => [new FakeLanguageBackend()] },
        cwdOverride: undefined,
        json: false,
        args: stubArgs("src/a.ts"),
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
        dependencies: { fs: repoWithFile(), backends: () => [new FakeLanguageBackend()] },
        cwdOverride: undefined,
        json: false,
        args: stubArgs("src/a.ts"),
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
        dependencies: { fs: repoWithFile(), backends: () => [new FakeLanguageBackend()] },
        cwdOverride: "/repo",
        json: false,
        args: stubArgs("src/a.ts"),
      },
    );

    expect(seenCwd).toBe("/repo");
    expect(context.exitCodes).toEqual([]);
  });
});

describe("runCommand input resolution", () => {
  it("resolves args.file against cwd and passes path + backend to compute", async () => {
    const context = createFakeProgramContext({ cwd: "/repo/src/nested" });
    const fs = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/src/nested/a.ts": "export const x = 1;",
    });
    const backend = new FakeLanguageBackend();
    let seenRelative = "";
    let seenBackend: unknown;

    await runCommand(
      new StubCommand({
        compute: async (ctx) => {
          seenRelative = ctx.path.relative;
          seenBackend = ctx.backend;
          return "ok";
        },
      }),
      {
        context,
        dependencies: { fs, backends: () => [backend] },
        cwdOverride: undefined,
        json: false,
        args: stubArgs("a.ts"),
      },
    );

    expect(seenRelative).toBe("src/nested/a.ts");
    expect(seenBackend).toBe(backend);
    expect(context.exitCodes).toEqual([]);
  });

  it("exits 1 with file-not-found when the resolved path does not exist", async () => {
    const context = createFakeProgramContext({ cwd: "/repo" });
    const fs = new InMemoryFileSystem({ "/repo/.git/HEAD": "ref: refs/heads/main\n" });

    await runCommand(new StubCommand(), {
      context,
      dependencies: { fs, backends: () => [new FakeLanguageBackend()] },
      cwdOverride: undefined,
      json: false,
      args: stubArgs("src/missing.ts"),
    });

    expect(context.stderr.text()).toBe("Cannot answer: file not found: src/missing.ts.\n");
    expect(context.exitCodes).toEqual([1]);
  });

  it("exits 1 with unsupported-extension when no backend accepts the resolved path", async () => {
    const context = createFakeProgramContext({ cwd: "/repo" });
    const fs = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/data.json": "{}\n",
    });

    await runCommand(new StubCommand(), {
      context,
      dependencies: {
        fs,
        backends: () => [new FakeLanguageBackend({ accept: () => false })],
      },
      cwdOverride: undefined,
      json: false,
      args: stubArgs("data.json"),
    });

    expect(context.stderr.text()).toBe("Cannot answer: cannot read .json files (data.json).\n");
    expect(context.exitCodes).toEqual([1]);
  });

  it("does not invoke compute when path resolution fails", async () => {
    const context = createFakeProgramContext({ cwd: "/repo" });
    const fs = new InMemoryFileSystem({ "/repo/.git/HEAD": "ref: refs/heads/main\n" });
    let computeCalls = 0;

    await runCommand(
      new StubCommand({
        compute: async () => {
          computeCalls += 1;
          return "ok";
        },
      }),
      {
        context,
        dependencies: { fs, backends: () => [new FakeLanguageBackend()] },
        cwdOverride: undefined,
        json: false,
        args: stubArgs("src/missing.ts"),
      },
    );

    expect(computeCalls).toBe(0);
    expect(context.exitCodes).toEqual([1]);
  });
});
