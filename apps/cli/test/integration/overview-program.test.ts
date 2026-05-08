import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { type LanguageBackend, type Workspace } from "@symnav/core";
import { inMemoryWorkspace } from "@symnav/testing";
import { TypeScriptBackend } from "@symnav/backend-typescript";
import { buildProgram } from "../../src/program.js";

class CapturedExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function makeStream(): { stream: Writable; chunks: string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString("utf8"));
      cb();
    },
  });
  return { stream, chunks };
}

async function runProgram(
  args: readonly string[],
  opts: {
    workspace: Workspace;
    cwd?: string;
    buildBackends?: (workspace: Workspace) => readonly LanguageBackend[];
  },
): Promise<{ status: number; stdout: string; stderr: string }> {
  const out = makeStream();
  const err = makeStream();
  let status = 0;
  const exit = (code: number): never => {
    status = code;
    throw new CapturedExit(code);
  };
  const program = buildProgram({
    stdout: out.stream,
    stderr: err.stream,
    cwd: opts.cwd ?? opts.workspace.root,
    exit,
    createWorkspace: () => Promise.resolve(opts.workspace),
    buildBackends: opts.buildBackends ?? ((ws) => [new TypeScriptBackend(ws)]),
  });
  try {
    await program.parseAsync(["node", "symnav", ...args]);
  } catch (e) {
    if (!(e instanceof CapturedExit)) throw e;
  }
  return { status, stdout: out.chunks.join(""), stderr: err.chunks.join("") };
}

async function makeWorkspace(extra: Record<string, string> = {}): Promise<Workspace> {
  return inMemoryWorkspace({
    files: {
      "/repo/.git/HEAD": "",
      "/repo/.gitignore": "ignored.ts\n",
      "/repo/src/x.ts": "export class Foo { greet(): void {} }",
      "/repo/ignored.ts": "export const y = 1;",
      "/repo/foo.json": "{}",
      ...extra,
    },
    startDir: "/repo",
  });
}

describe("symnav overview", () => {
  it("writes text-rendered IR to stdout, exit 0", async () => {
    const ws = await makeWorkspace();
    const { status, stdout, stderr } = await runProgram(["overview", "src/x.ts"], {
      workspace: ws,
    });
    expect(status).toBe(0);
    expect(stdout).toContain("Overview: src/x.ts");
    expect(stdout).toContain("Foo");
    expect(stdout).toContain("Foo::greet");
    expect(stderr).toBe("");
  });

  it("--json writes JSON to stdout, exit 0", async () => {
    const ws = await makeWorkspace();
    const { status, stdout } = await runProgram(["overview", "src/x.ts", "--json"], {
      workspace: ws,
    });
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as { filePath: string };
    expect(parsed.filePath).toBe("src/x.ts");
  });

  it("missing file → exit 1 with file-not-found Cannot answer line", async () => {
    const ws = await makeWorkspace();
    const { status, stderr } = await runProgram(["overview", "missing.ts"], { workspace: ws });
    expect(status).toBe(1);
    expect(stderr).toBe("Cannot answer: file not found: missing.ts.\n");
  });

  it("path outside workspace → exit 1 with outside-workspace line", async () => {
    const ws = await makeWorkspace({ "/elsewhere/x.ts": "" });
    const { status, stderr } = await runProgram(["overview", "/elsewhere/x.ts"], { workspace: ws });
    expect(status).toBe(1);
    expect(stderr).toContain("Cannot answer: /elsewhere/x.ts is outside the workspace");
  });

  it("ignored file → exit 1 with ignored-by-gitignore line", async () => {
    const ws = await makeWorkspace();
    const { status, stderr } = await runProgram(["overview", "ignored.ts"], { workspace: ws });
    expect(status).toBe(1);
    expect(stderr).toBe("Cannot answer: ignored.ts is ignored by .gitignore.\n");
  });

  it("unsupported file extension → exit 1 with unsupported line", async () => {
    const ws = await makeWorkspace();
    const { status, stderr } = await runProgram(["overview", "foo.json"], { workspace: ws });
    expect(status).toBe(1);
    expect(stderr).toContain("Cannot answer: unsupported file type .json");
  });

  it("--cwd overrides startDir for relative-path resolution", async () => {
    const ws = await makeWorkspace();
    const { status, stdout } = await runProgram(["--cwd", "/repo/src", "overview", "x.ts"], {
      workspace: ws,
      cwd: "/elsewhere",
    });
    expect(status).toBe(0);
    expect(stdout).toContain("Overview: src/x.ts");
  });

  it("unexpected internal error → exit 2", async () => {
    const ws = await makeWorkspace();
    const explosive: LanguageBackend = {
      accepts: () => true,
      fileSymbols: () => Promise.reject(new Error("boom")),
    };
    const { status, stderr } = await runProgram(["overview", "src/x.ts"], {
      workspace: ws,
      buildBackends: () => [explosive],
    });
    expect(status).toBe(2);
    expect(stderr).toContain("Internal error: boom");
  });
});
