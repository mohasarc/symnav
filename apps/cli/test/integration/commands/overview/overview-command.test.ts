import { describe, expect, it } from "vitest";
import {
  InMemoryFileSystem,
  type OverviewExpansionResult,
  type OverviewFileEntries,
} from "@symnav/core";
import { buildProgram } from "../../../../src/program.js";
import { FakeLanguageBackend } from "../helpers/fake-language-backend.js";
import { fakeDependencies } from "../helpers/fake-program-dependencies.js";
import { createFakeProgramContext } from "../helpers/fake-program-context.js";

async function parse(
  argv: readonly string[],
  deps: Parameters<typeof buildProgram>[1],
  cwd = "/repo",
): Promise<{
  stdout: string;
  stderr: string;
  exitCodes: readonly number[];
}> {
  const context = createFakeProgramContext({ cwd });
  const program = buildProgram(context, deps);
  await program.parseAsync([...argv], { from: "user" });
  return {
    stdout: context.stdout.text(),
    stderr: context.stderr.text(),
    exitCodes: context.exitCodes,
  };
}

describe("symnav overview happy path", () => {
  it("writes text-rendered IR to stdout with exit 0", async () => {
    const entries: OverviewFileEntries = {
      file: "src/a.ts",
      entries: [
        {
          type: "symbol",
          identity: { file: "src/a.ts", segments: [{ name: "greet" }] },
          kind: { role: "callable", nativeLabel: "function" },
          range: { startLine: 1, endLine: 1 },
          header: { startLine: 1, lines: ["function greet(): void"] },
          children: [],
        },
      ],
    };
    const fs = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/src/a.ts": "export function greet(): void {}\n",
    });
    const backend = new FakeLanguageBackend({ entries: () => entries });

    const r = await parse(
      ["overview", "src/a.ts"],
      fakeDependencies({
        fs,
        backends: () => [backend],
      }),
    );

    expect(r.stderr).toBe("");
    expect(r.exitCodes).toEqual([]);
    expect(r.stdout).toContain("src/a.ts");
    expect(r.stdout).toContain("greet");
  });

  it("writes JSON output with --json flag", async () => {
    const entries: OverviewFileEntries = { file: "src/a.ts", entries: [] };
    const fs = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/src/a.ts": "export const x = 1;\n",
    });
    const backend = new FakeLanguageBackend({ entries: () => entries });

    const r = await parse(
      ["overview", "src/a.ts", "--json"],
      fakeDependencies({
        fs,
        backends: () => [backend],
      }),
    );

    expect(r.stderr).toBe("");
    expect(r.exitCodes).toEqual([]);
    const parsed = JSON.parse(r.stdout) as OverviewExpansionResult;
    expect(parsed).toEqual({
      ...entries,
      request: { depth: 0 },
      totalSymbolCount: 0,
    });
  });

  it("--cwd overrides startDir for root detection and relative-path resolution", async () => {
    const fs = new InMemoryFileSystem({
      "/other/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/other/repo/src/a.ts": "export const x = 1;\n",
    });
    const backend = new FakeLanguageBackend();

    const r = await parse(
      ["--cwd", "/other/repo", "overview", "src/a.ts"],
      fakeDependencies({ fs, backends: () => [backend] }),
      "/unrelated",
    );

    expect(r.stderr).toBe("");
    expect(r.exitCodes).toEqual([]);
    expect(backend.calls).toEqual(["src/a.ts"]);
  });
});

describe("symnav overview user errors", () => {
  it("writes the file-not-found line to stderr with exit 1 for a missing file", async () => {
    const fs = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
    });
    const backend = new FakeLanguageBackend();

    const r = await parse(
      ["overview", "src/missing.ts"],
      fakeDependencies({
        fs,
        backends: () => [backend],
      }),
    );

    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("Cannot answer: file not found: src/missing.ts.\n");
    expect(r.exitCodes).toEqual([1]);
  });

  it("writes the outside-workspace line for a path outside the workspace", async () => {
    const fs = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/other/src/a.ts": "export const x = 1;\n",
    });
    const backend = new FakeLanguageBackend();

    const r = await parse(
      ["overview", "/other/src/a.ts"],
      fakeDependencies({
        fs,
        backends: () => [backend],
      }),
    );

    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      "Cannot answer: /other/src/a.ts is outside the workspace rooted at /repo.\n",
    );
    expect(r.exitCodes).toEqual([1]);
  });

  it("writes the ignored line for an ignored path", async () => {
    const fs = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/.gitignore": "build/\n",
      "/repo/build/a.ts": "export const x = 1;\n",
    });
    const backend = new FakeLanguageBackend();

    const r = await parse(
      ["overview", "build/a.ts"],
      fakeDependencies({
        fs,
        backends: () => [backend],
      }),
    );

    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("Cannot answer: build/a.ts is ignored by .gitignore.\n");
    expect(r.exitCodes).toEqual([1]);
  });

  it("writes the unsupported-extension line citing .json for a .json file", async () => {
    const fs = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/data.json": "{}\n",
    });
    const backend = new FakeLanguageBackend({ accept: () => false });

    const r = await parse(
      ["overview", "data.json"],
      fakeDependencies({
        fs,
        backends: () => [backend],
      }),
    );

    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("Cannot answer: cannot read .json files (data.json).\n");
    expect(r.exitCodes).toEqual([1]);
  });

  it("writes the no-workspace line when there is no .git in or above cwd", async () => {
    const fs = new InMemoryFileSystem({
      "/loose/src/a.ts": "export const x = 1;\n",
    });
    const backend = new FakeLanguageBackend();

    const r = await parse(
      ["overview", "src/a.ts"],
      fakeDependencies({ fs, backends: () => [backend] }),
      "/loose",
    );

    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      "Cannot answer: not in a git workspace (no .git found in or above /loose).\n",
    );
    expect(r.exitCodes).toEqual([1]);
  });

  it("exits 2 and writes the message to stderr for an unexpected internal error", async () => {
    const fs = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/src/a.ts": "export const x = 1;\n",
    });
    const throwingBackend = new FakeLanguageBackend({
      entries: () => {
        throw new Error("backend went sideways");
      },
    });

    const r = await parse(
      ["overview", "src/a.ts"],
      fakeDependencies({
        fs,
        backends: () => [throwingBackend],
      }),
    );

    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("backend went sideways\n");
    expect(r.exitCodes).toEqual([2]);
  });
});
