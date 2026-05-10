import { describe, expect, it } from "vitest";
import type { FileSymbols } from "@symnav/core";
import { buildProgram } from "../../../../src/program.js";
import { InMemoryFileSystem } from "../../../helpers/in-memory-file-system.js";
import { FakeLanguageBackend } from "./fake-language-backend.js";
import { createFakeProgramContext, ExitCalledError } from "./fake-program-context.js";

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
  try {
    await program.parseAsync([...argv], { from: "user" });
  } catch (err) {
    if (!(err instanceof ExitCalledError)) throw err;
  }
  return {
    stdout: context.stdout.text(),
    stderr: context.stderr.text(),
    exitCodes: context.exitCodes,
  };
}

describe("symnav overview happy path", () => {
  it("writes text-rendered IR to stdout with exit 0", async () => {
    const symbols: FileSymbols = {
      filePath: "src/a.ts",
      symbols: [
        {
          kind: "function",
          name: "greet",
          range: { startLine: 1, endLine: 1 },
          signatureSource: "function greet(): void",
          children: [],
        },
      ],
    };
    const fs = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/src/a.ts": "export function greet(): void {}\n",
    });
    const backend = new FakeLanguageBackend({ symbols: () => symbols });

    const r = await parse(["overview", "src/a.ts"], {
      fs,
      backends: () => [backend],
    });

    expect(r.stderr).toBe("");
    expect(r.exitCodes).toEqual([]);
    expect(r.stdout).toContain("src/a.ts");
    expect(r.stdout).toContain("greet");
  });

  it("writes JSON output with --json flag", async () => {
    const symbols: FileSymbols = { filePath: "src/a.ts", symbols: [] };
    const fs = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/src/a.ts": "export const x = 1;\n",
    });
    const backend = new FakeLanguageBackend({ symbols: () => symbols });

    const r = await parse(["overview", "src/a.ts", "--json"], {
      fs,
      backends: () => [backend],
    });

    expect(r.stderr).toBe("");
    expect(r.exitCodes).toEqual([]);
    const parsed = JSON.parse(r.stdout) as FileSymbols;
    expect(parsed).toEqual(symbols);
  });

  it("--cwd overrides startDir for root detection and relative-path resolution", async () => {
    const fs = new InMemoryFileSystem({
      "/other/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/other/repo/src/a.ts": "export const x = 1;\n",
    });
    const backend = new FakeLanguageBackend();

    const r = await parse(
      ["--cwd", "/other/repo", "overview", "src/a.ts"],
      { fs, backends: () => [backend] },
      "/unrelated",
    );

    expect(r.stderr).toBe("");
    expect(r.exitCodes).toEqual([]);
    expect(backend.calls).toEqual(["src/a.ts"]);
  });
});
