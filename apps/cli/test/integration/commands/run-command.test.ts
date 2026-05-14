import { describe, expect, it } from "vitest";
import { InMemoryFileSystem, UserFacingError } from "@symnav/core";
import { Command, runCommand } from "../../../src/command.js";
import type { CommandContext } from "../../../src/command.js";
import { FakeLanguageBackend } from "./overview/fake-language-backend.js";
import { createFakeProgramContext } from "./overview/fake-program-context.js";

class StubCommand extends Command<string> {
  constructor(
    private readonly options: {
      compute?: (ctx: CommandContext) => Promise<string>;
    } = {},
  ) {
    super();
  }

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

describe("runCommand lifecycle", () => {
  it("writes the rendered text result to stdout on success", async () => {
    const context = createFakeProgramContext({ cwd: "/repo" });
    const fs = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
    });

    await runCommand(new StubCommand(), {
      context,
      dependencies: { fs, backends: () => [new FakeLanguageBackend()] },
      cwdOverride: undefined,
      json: false,
    });

    expect(context.stdout.text()).toBe("text:computed");
    expect(context.stderr.text()).toBe("");
    expect(context.exitCodes).toEqual([]);
  });

  it("selects renderJson when json is true", async () => {
    const context = createFakeProgramContext({ cwd: "/repo" });
    const fs = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
    });

    await runCommand(new StubCommand(), {
      context,
      dependencies: { fs, backends: () => [new FakeLanguageBackend()] },
      cwdOverride: undefined,
      json: true,
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
    });

    expect(context.stdout.text()).toBe("");
    expect(context.stderr.text()).toBe(
      "Cannot answer: not in a git workspace (no .git found in or above /loose).\n",
    );
    expect(context.exitCodes).toEqual([1]);
  });

  it("writes a Cannot answer line and exits 1 when compute throws a UserFacingError", async () => {
    const context = createFakeProgramContext({ cwd: "/repo" });
    const fs = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
    });

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
        dependencies: { fs, backends: () => [new FakeLanguageBackend()] },
        cwdOverride: undefined,
        json: false,
      },
    );

    expect(context.stdout.text()).toBe("");
    expect(context.stderr.text()).toBe("Cannot answer: something went wrong.\n");
    expect(context.exitCodes).toEqual([1]);
  });

  it("writes the raw message and exits 2 when compute throws a non-UserFacingError", async () => {
    const context = createFakeProgramContext({ cwd: "/repo" });
    const fs = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
    });

    await runCommand(
      new StubCommand({
        compute: () => {
          throw new Error("internal boom");
        },
      }),
      {
        context,
        dependencies: { fs, backends: () => [new FakeLanguageBackend()] },
        cwdOverride: undefined,
        json: false,
      },
    );

    expect(context.stdout.text()).toBe("");
    expect(context.stderr.text()).toBe("internal boom\n");
    expect(context.exitCodes).toEqual([2]);
  });

  it("resolves cwd from cwdOverride when provided", async () => {
    const context = createFakeProgramContext({ cwd: "/unrelated" });
    const fs = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
    });
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
        dependencies: { fs, backends: () => [new FakeLanguageBackend()] },
        cwdOverride: "/repo",
        json: false,
      },
    );

    expect(seenCwd).toBe("/repo");
    expect(context.exitCodes).toEqual([]);
  });
});
